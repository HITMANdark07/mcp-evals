import { ConfigError, ProviderError } from '../errors.js';
import type { ChatRequest, ChatResponse, JsonObject, ModelProvider } from '../types.js';
import { isPlainObject } from '../util.js';
import {
  AbortedAfterSend,
  classifyHttpError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  messageOf,
  numberOr,
  parseToolCall,
  requestJson,
  toWireMessage,
  toWireTools,
  trimBaseUrl,
  type ChatEndpoint,
} from './openai-chat.js';

export const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible';

export interface OpenAICompatibleOptions {
  /** e.g. http://localhost:11434/v1 (Ollama). `/chat/completions` and `/models` are appended. */
  baseUrl: string;
  /** Optional; sent as a Bearer token when set. Kept in a private field; never logged, traced, or put in error messages. */
  apiKey?: string;
  requestTimeoutMs?: number;
  now?: () => number;
}

/**
 * A local or self-hosted server that speaks the OpenAI chat-completions format (Ollama, LM Studio, vLLM,
 * llama.cpp server). Such servers report no price, so **cost is not measured: every call costs $0**. That is a
 * deliberate, documented choice, not an unknown cost: the run never stops for "cost could not be determined",
 * and the budget cap still applies but never trips. Token counts come from `usage` when the server sends it, else 0.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = OPENAI_COMPATIBLE_PROVIDER;
  readonly #endpoint: ChatEndpoint;
  readonly #now: () => number;
  #generatedIds = 0;

  constructor(o: OpenAICompatibleOptions) {
    this.#endpoint = endpoint(o);
    this.#now = o.now ?? Date.now;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Plain OpenAI request: no provider pinning and no OpenRouter-specific fields. A suite's pin, if any, is ignored.
    const body: JsonObject = {
      model: req.model,
      messages: req.messages.map((m) => toWireMessage(m)),
      temperature: req.temperature,
    };
    if (req.tools.length > 0) body.tools = toWireTools(req.tools);
    const t0 = this.#now();
    let json: unknown;
    try {
      json = await requestJson(this.#endpoint, 'POST', '/chat/completions', body, req.signal);
    } catch (e) {
      // A cut-off request costs nothing locally: re-throw as a plain ProviderError with no cost, never CostUnknownError.
      if (e instanceof AbortedAfterSend) throw new ProviderError(e.message, e.retryable, e.status, 0);
      throw e;
    }
    return this.#parseCompletion(json, this.#now() - t0);
  }

  #parseCompletion(json: unknown, latencyMs: number): ChatResponse {
    const label = this.#endpoint.label;
    if (!isPlainObject(json)) throw new ProviderError(`${label}: malformed response (not a JSON object)`, false);
    const choices = json.choices;
    if (isPlainObject(json.error) && !Array.isArray(choices)) throw classifyHttpError(this.#endpoint, numberOr(json.error.code, 502), messageOf(json.error));
    const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const msg = isPlainObject(choice) ? choice.message : undefined;
    if (!isPlainObject(choice) || !isPlainObject(msg)) throw new ProviderError(`${label}: malformed response (no choices[0].message)`, false);
    if (choice.finish_reason === 'error') throw new ProviderError(`${label}: generation interrupted`, true, 502);
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    // Local servers may omit usage (or parts of it): missing token counts are recorded as 0.
    const usage = isPlainObject(json.usage) ? json.usage : {};
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: rawCalls.map((c: unknown) => parseToolCall(c, () => `gen_call_${++this.#generatedIds}`)),
      usage: { promptTokens: numberOr(usage.prompt_tokens, 0), completionTokens: numberOr(usage.completion_tokens, 0), costUsd: 0 },
      latencyMs,
    };
  }
}

/** GET {base}/models: the model ids the server lists (OpenAI format `{ data: [{ id }] }`). */
export async function fetchServedModels(o: Pick<OpenAICompatibleOptions, 'baseUrl' | 'apiKey' | 'requestTimeoutMs'>): Promise<Set<string>> {
  const ep = endpoint(o);
  const json = await requestJson(ep, 'GET', '/models', undefined);
  const data = isPlainObject(json) ? json.data : undefined;
  if (!Array.isArray(data)) throw new ProviderError(`${ep.label}: malformed model list (no data array)`, false);
  const ids = new Set<string>();
  for (const m of data) if (isPlainObject(m) && typeof m.id === 'string') ids.add(m.id);
  return ids;
}

function endpoint(o: Pick<OpenAICompatibleOptions, 'baseUrl' | 'apiKey' | 'requestTimeoutMs'>): ChatEndpoint {
  const baseUrl = trimBaseUrl(o.baseUrl.trim());
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`invalid base URL "${baseUrl}" (expected e.g. http://localhost:11434/v1)`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`base URL must be http(s), got "${baseUrl}"`);
  const apiKey = o.apiKey?.trim();
  return {
    label: 'OpenAI-compatible server',
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    requestTimeoutMs: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}
