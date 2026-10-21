// Shared by every provider that speaks the OpenAI chat-completions wire format (OpenRouter, local servers):
// HTTP with timeout/abort, error classification, and message/tool conversion.
import { OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatMessage, JsonObject, ToolCall, ToolDef } from '../types.js';
import { isPlainObject } from '../util.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface ChatEndpoint {
  /** Prefix for error messages, e.g. "OpenRouter". */
  label: string;
  /** Without a trailing slash. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer …` when set. Never logged, traced, or put in error messages. */
  apiKey?: string;
  requestTimeoutMs: number;
  /** Extra request headers (e.g. OpenRouter's X-Title). */
  headers?: Record<string, string>;
  /** OpenRouter only: 402 and 403 key/credit-limit answers are final (OutOfCreditsError), not ordinary 4xx. */
  creditErrors?: boolean;
  /** Spend reported in an HTTP error body (OpenRouter's usage.cost); default 0. */
  errorBodyCostUsd?: (json: unknown) => number;
}

export function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** A request cut off (run abort or request timeout) after it was sent; a paid provider may still bill it. */
export class AbortedAfterSend extends ProviderError {}

export async function requestJson(ep: ChatEndpoint, method: 'GET' | 'POST', path: string, body: JsonObject | undefined, signal?: AbortSignal): Promise<unknown> {
  const key = ep.apiKey;
  // An empty key must not be "redacted": splitting on '' would mangle every character.
  const redact = (s: string) => (key ? s.split(key).join('[redacted]') : s);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ep.requestTimeoutMs);
  const forwardAbort = () => controller.abort();
  const abortedBeforeSend = signal?.aborted === true;
  if (abortedBeforeSend) controller.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${ep.baseUrl}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json', ...ep.headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (timedOut) throw new AbortedAfterSend(`${ep.label} request timed out after ${ep.requestTimeoutMs}ms`, true);
    if (abortedBeforeSend) throw new ProviderError(`${ep.label} request aborted before it was sent`, false);
    if (signal?.aborted) throw new AbortedAfterSend(`${ep.label} request aborted`, false);
    throw new ProviderError(redact(`${ep.label} network error: ${describe(e)}`), true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
  let json: unknown;
  let parsed = true;
  try {
    json = JSON.parse(text);
  } catch {
    parsed = false;
  }
  if (status < 200 || status >= 300) {
    const err = isPlainObject(json) ? json.error : undefined;
    const message = isPlainObject(err) ? messageOf(err) : redact(text).slice(0, 300) || '(empty body)';
    throw classifyHttpError(ep, status, redact(message), ep.errorBodyCostUsd?.(json) ?? 0);
  }
  if (!parsed) throw new ProviderError(`${ep.label}: malformed response JSON (HTTP ${status})`, false);
  if (isPlainObject(json) && isPlainObject(json.error)) {
    const err = json.error;
    err.message = redact(messageOf(err));
  }
  return json;
}

/** 408/429/5xx are retryable; other statuses are not. With `creditErrors`, 402 and 403 key/credit limits stop the run. */
export function classifyHttpError(ep: Pick<ChatEndpoint, 'label' | 'creditErrors'>, status: number, message: string, costUsd = 0): Error {
  const text = `${ep.label} ${status}: ${message}`;
  if (ep.creditErrors) {
    if (status === 402) return new OutOfCreditsError(text, costUsd);
    // OpenRouter answers 403 when the key's own spend limit is reached: as final as running out of credits.
    if (status === 403 && /limit/i.test(message) && /key|credit/i.test(message)) return new OutOfCreditsError(text, costUsd);
  }
  if (status === 408 || status === 429 || status >= 500) return new ProviderError(text, true, status, costUsd);
  return new ProviderError(text, false, status, costUsd);
}

export function messageOf(err: JsonObject): string {
  return typeof err.message === 'string' ? err.message : 'unknown error';
}

export function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
}

export function toWireTools(tools: ToolDef[]): JsonObject[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/**
 * One message in the OpenAI chat format. `reasoningDetails` (OpenRouter) sends an assistant message's
 * `providerMetadata.reasoning_details` back unchanged, as reasoning models need to continue a tool-call turn.
 */
export function toWireMessage(m: ChatMessage, o: { reasoningDetails?: boolean } = {}): JsonObject {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
          : {}),
        ...(o.reasoningDetails && isPlainObject(m.providerMetadata) && m.providerMetadata.reasoning_details !== undefined
          ? { reasoning_details: m.providerMetadata.reasoning_details }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}

/** Parses one wire tool call. `generateId` fills a missing id, since tool results must reference a unique one. */
export function parseToolCall(c: unknown, generateId: () => string): ToolCall {
  const call = isPlainObject(c) ? c : {};
  const fn = isPlainObject(call.function) ? call.function : {};
  const args = fn.arguments;
  return {
    id: typeof call.id === 'string' && call.id !== '' ? call.id : generateId(),
    name: typeof fn.name === 'string' ? fn.name : '',
    arguments: typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args),
  };
}
