import { CostUnknownError, InfraError, OutOfCreditsError, ProviderError, spentUsd, ToolTimeoutError } from '../errors.js';
import type { ToolMapping } from '../tools/convert.js';
import type { ChatMessage, ChatResponse, JsonObject, LoopEnd, McpConnection, ModelProvider, ToolCallResult, TraceEvent } from '../types.js';
import { countTokens } from '../tokens.js';
import { isPlainObject } from '../util.js';

export const SYSTEM_PROMPT =
  'You are an agent completing a task with the tools provided. Use tools when they help. ' +
  'When you are finished, reply with your final answer as plain text and do not call any more tools.';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
/** After the run deadline aborts a model call, how long to wait for the provider to report what that call cost. */
export const DEFAULT_ABORT_GRACE_MS = 500;

export interface AgentLoopOptions {
  provider: ModelProvider;
  connection: McpConnection;
  tools: ToolMapping;
  model: string;
  /** OpenRouter provider slug for this model (suite pin). */
  providerPin?: string;
  prompt: string;
  maxSteps: number;
  timeoutMs: number;
  temperature: number;
  systemPrompt?: string;
  toolTimeoutMs?: number;
  /** Called before each model call with this loop's spend so far; return true to stop. */
  shouldStop?: (loopCostUsd: number) => boolean;
  /** See DEFAULT_ABORT_GRACE_MS. */
  abortGraceMs?: number;
  now?: () => number;
}

export interface AgentRunResult {
  end: LoopEnd;
  finalAnswer: string | null;
  failReason?: string;
  infraError?: InfraError;
  /** The provider reported 402 (or a 403 key limit): the whole run must stop. */
  outOfCredits?: boolean;
  /** The spend of a model call could not be determined (the reason): the whole run must stop. */
  costUnknown?: string;
  events: TraceEvent[];
  steps: number;
  costUsd: number;
  contextTokens: number;
  latencyMs: number;
}

class LoopTimeout extends Error {}

export async function runAgentLoop(o: AgentLoopOptions): Promise<AgentRunResult> {
  const now = o.now ?? Date.now;
  const start = now();
  const deadline = start + o.timeoutMs;
  const t = () => now() - start;
  const events: TraceEvent[] = [];
  const messages: ChatMessage[] = [
    { role: 'system', content: o.systemPrompt ?? SYSTEM_PROMPT },
    { role: 'user', content: o.prompt },
  ];
  let steps = 0;
  let costUsd = 0;
  let contextTokens = 0;

  const finish = (end: LoopEnd, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
    end,
    finalAnswer: null,
    events,
    steps,
    costUsd,
    contextTokens,
    latencyMs: t(),
    ...extra,
  });

  for (;;) {
    if (o.shouldStop?.(costUsd)) return finish('budget', { failReason: 'budget exhausted' });
    if (steps >= o.maxSteps) return finish('max_steps', { failReason: `reached max_steps (${o.maxSteps})` });
    const remaining = deadline - now();
    if (remaining <= 0) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });

    steps++;
    const controller = new AbortController();
    let call: Promise<ChatResponse>;
    try {
      call = o.provider.chat({
        model: o.model,
        ...(o.providerPin !== undefined ? { providerPin: o.providerPin } : {}),
        messages,
        tools: o.tools.defs,
        temperature: o.temperature,
        signal: controller.signal,
      });
    } catch (e) {
      call = Promise.reject(e);
    }
    let res: ChatResponse;
    try {
      res = await withTimeout(call, remaining, controller);
    } catch (caught) {
      let e: unknown = caught;
      if (e instanceof LoopTimeout) {
        // The deadline aborted the call. It may still be billed: give the provider a moment to report its spend.
        const settled = await settle(call, o.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS);
        if (settled.ok) costUsd += settled.value.usage.costUsd;
        else if (settled.error instanceof CostUnknownError) e = settled.error;
        else costUsd += spentUsd(settled.error);
        if (!(e instanceof CostUnknownError)) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
      }
      costUsd += spentUsd(e);
      if (e instanceof CostUnknownError) {
        events.push({ type: 'error', step: steps, t: t(), kind: 'cost_unknown', message: e.message });
        return finish('budget', { failReason: e.message, costUnknown: e.reason });
      }
      if (e instanceof OutOfCreditsError) return finish('budget', { failReason: e.message, outOfCredits: true });
      const message = e instanceof Error ? e.message : String(e);
      // Only known-transient provider failures are retried; unknown exceptions are likely bugs and would repeat.
      const retryable = e instanceof ProviderError ? e.retryable : false;
      events.push({ type: 'error', step: steps, t: t(), kind: 'provider', message });
      return finish('infra_error', { infraError: new InfraError('provider', message, retryable), failReason: message });
    }

    costUsd += res.usage.costUsd;
    events.push({
      type: 'model_call', step: steps, t: t(), latencyMs: res.latencyMs,
      promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, costUsd: res.usage.costUsd,
      ...(res.servedBy !== undefined ? { servedBy: res.servedBy } : {}),
    });

    if (res.toolCalls.length === 0) {
      const text = res.content ?? '';
      events.push({ type: 'final_answer', step: steps, t: t(), text });
      return finish('final_answer', { finalAnswer: text });
    }

    messages.push({
      role: 'assistant',
      content: res.content,
      toolCalls: res.toolCalls,
      ...(res.providerMetadata !== undefined ? { providerMetadata: res.providerMetadata } : {}),
    });
    for (const call of res.toolCalls) {
      const tool = o.tools.toMcpName(call.name);
      const args = parseArgs(call.arguments);
      events.push({ type: 'tool_call', step: steps, t: t(), callId: call.id, tool: tool ?? call.name, args, rawArgs: call.arguments });
      if (tool === undefined) return finish('invalid_tool_call', { failReason: `model called unknown tool "${call.name}"` });
      if (args === null) return finish('invalid_tool_call', { failReason: `model sent invalid JSON arguments to "${tool}"` });

      if (deadline - now() <= 0) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
      const configured = o.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const remainingMs = deadline - now();
      const capped = remainingMs < configured;
      const toolTimeout = Math.max(1, Math.min(configured, remainingMs));
      const t0 = now();
      let result: ToolCallResult;
      try {
        result = await o.connection.callTool(tool, args, toolTimeout);
      } catch (e) {
        if (e instanceof ToolTimeoutError) {
          // Cut short by the run deadline: the run timed out. Otherwise the tool itself was too slow for the policy.
          if (capped || now() >= deadline) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
          events.push({ type: 'error', step: steps, t: t(), kind: 'tool_timeout', message: e.message });
          return finish('tool_timeout', { failReason: `tool "${tool}" exceeded the ${configured}ms tool timeout` });
        }
        if (now() >= deadline) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
        const infra = e instanceof InfraError ? e : new InfraError('server', e instanceof Error ? e.message : String(e), false);
        events.push({ type: 'error', step: steps, t: t(), kind: infra.kind, message: infra.message });
        return finish('infra_error', { infraError: infra, failReason: infra.message });
      }
      const tokens = countTokens(result.text);
      contextTokens += tokens;
      events.push({
        type: 'tool_result', step: steps, t: t(), callId: call.id, tool,
        isError: result.isError, tokens, latencyMs: now() - t0, preview: result.text.slice(0, 500),
      });
      messages.push({ role: 'tool', toolCallId: call.id, content: result.text });
    }
  }
}

function parseArgs(raw: string): JsonObject | null {
  if (raw.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** How `p` settles within `ms` (a promise still pending then counts as an error with no spend). */
async function settle<T>(p: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: undefined }), ms);
  });
  try {
    return await Promise.race([p.then((value): Settled<T> => ({ ok: true, value }), (error: unknown): Settled<T> => ({ ok: false, error })), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new LoopTimeout());
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
