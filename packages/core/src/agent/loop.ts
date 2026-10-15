import { InfraError, ProviderError } from '../errors.js';
import type { ToolMapping } from '../tools/convert.js';
import type { ChatMessage, ChatResponse, JsonObject, LoopEnd, McpConnection, ModelProvider, ToolCallResult, TraceEvent } from '../types.js';
import { estimateTokens, isPlainObject } from '../util.js';

export const SYSTEM_PROMPT =
  'You are an agent completing a task with the tools provided. Use tools when they help. ' +
  'When you are finished, reply with your final answer as plain text and do not call any more tools.';

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface AgentLoopOptions {
  provider: ModelProvider;
  connection: McpConnection;
  tools: ToolMapping;
  model: string;
  prompt: string;
  maxSteps: number;
  timeoutMs: number;
  temperature: number;
  systemPrompt?: string;
  toolTimeoutMs?: number;
  /** Called before each model call with this loop's spend so far; return true to stop. */
  shouldStop?: (loopCostUsd: number) => boolean;
  now?: () => number;
}

export interface AgentRunResult {
  end: LoopEnd;
  finalAnswer: string | null;
  failReason?: string;
  infraError?: InfraError;
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
    let res: ChatResponse;
    try {
      res = await withTimeout(
        o.provider.chat({ model: o.model, messages, tools: o.tools.defs, temperature: o.temperature, signal: controller.signal }),
        remaining,
        controller,
      );
    } catch (e) {
      if (e instanceof LoopTimeout) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
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
    });

    if (res.toolCalls.length === 0) {
      const text = res.content ?? '';
      events.push({ type: 'final_answer', step: steps, t: t(), text });
      return finish('final_answer', { finalAnswer: text });
    }

    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
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
        if (e instanceof InfraError && (now() >= deadline || (capped && now() - t0 >= toolTimeout - 5))) return finish('timeout', { failReason: `timed out after ${o.timeoutMs}ms` });
        const infra = e instanceof InfraError ? e : new InfraError('server', e instanceof Error ? e.message : String(e), false);
        events.push({ type: 'error', step: steps, t: t(), kind: infra.kind, message: infra.message });
        return finish('infra_error', { infraError: infra, failReason: infra.message });
      }
      const tokens = estimateTokens(result.text);
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
