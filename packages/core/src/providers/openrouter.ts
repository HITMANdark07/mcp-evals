import { ConfigError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatMessage, ChatRequest, ChatResponse, JsonObject, ModelProvider, ToolCall } from '../types.js';
import { isPlainObject } from '../util.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** USD per token, from the OpenRouter model catalog. */
export interface ModelPrice {
  prompt: number;
  completion: number;
}

export interface CatalogModel {
  id: string;
  supportsTools: boolean;
  price: ModelPrice | null;
}

export interface OpenRouterOptions {
  /** OPENROUTER_API_KEY. Kept in a private field; never logged, traced, or put in error messages. */
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  /** Catalog prices, used only when a response lacks usage.cost (so the budget cap still holds). */
  prices?: Record<string, ModelPrice>;
  now?: () => number;
}

interface Endpoint {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
}

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  readonly #endpoint: Endpoint;
  readonly #prices: Record<string, ModelPrice>;
  readonly #now: () => number;
  #generatedIds = 0;

  constructor(o: OpenRouterOptions) {
    const apiKey = o.apiKey.trim();
    if (apiKey === '') throw new ConfigError('OPENROUTER_API_KEY is empty');
    this.#endpoint = endpoint({ ...o, apiKey });
    this.#prices = o.prices ?? {};
    this.#now = o.now ?? Date.now;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!req.providerPin) {
      throw new ConfigError(`model "${req.model}" has no provider pin; OpenRouter runs need { id, provider } model entries`);
    }
    const body: JsonObject = {
      model: req.model,
      messages: req.messages.map(toWireMessage),
      temperature: req.temperature,
      provider: { order: [req.providerPin], allow_fallbacks: false },
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const t0 = this.#now();
    const json = await request(this.#endpoint, 'POST', '/chat/completions', body, req.signal);
    return this.#parseCompletion(json, req.model, this.#now() - t0);
  }

  #parseCompletion(json: unknown, model: string, latencyMs: number): ChatResponse {
    if (!isPlainObject(json)) throw new ProviderError('OpenRouter: malformed response (not a JSON object)', false);
    const error = json.error;
    const choices = json.choices;
    // A 200 can still carry an error: OpenRouter reports upstream failures in the body.
    if (isPlainObject(error) && !Array.isArray(choices)) throw classify(numberOr(error.code, 502), messageOf(error));
    const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
    if (!isPlainObject(choice)) throw new ProviderError('OpenRouter: malformed response (no choices[0].message)', false);
    const msg = choice.message;
    if (!isPlainObject(msg)) throw new ProviderError('OpenRouter: malformed response (no choices[0].message)', false);
    if (choice.finish_reason === 'error') {
      throw new ProviderError(`OpenRouter: generation interrupted: ${isPlainObject(error) ? messageOf(error) : 'unknown error'}`, true, 502);
    }
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const usageObj = isPlainObject(json.usage) ? json.usage : undefined;
    const usage = usageObj ?? {};
    const promptTokens = numberOr(usage.prompt_tokens, 0);
    const completionTokens = numberOr(usage.completion_tokens, 0);
    const price = this.#prices[model];
    const reportedCost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
    let costUsd: number;
    if (reportedCost !== undefined) costUsd = reportedCost;
    else if (usageObj && price && validPrice(price.prompt) !== null && validPrice(price.completion) !== null) {
      costUsd = promptTokens * price.prompt + completionTokens * price.completion;
    } else {
      throw new ProviderError(
        `cannot determine cost for ${model}: response had no usage.cost and no catalog price is known; refusing to continue without budget accounting`,
        false,
      );
    }
    const servedBy = json.provider;
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: rawCalls.map((c: unknown) => this.#toolCall(c)),
      usage: { promptTokens, completionTokens, costUsd },
      latencyMs,
      ...(typeof servedBy === 'string' ? { servedBy } : {}),
    };
  }

  #toolCall(c: unknown): ToolCall {
    const call = isPlainObject(c) ? c : {};
    const fn = isPlainObject(call.function) ? call.function : {};
    const args = fn.arguments;
    return {
      // Some providers omit ids; tool results must still reference a unique one.
      id: typeof call.id === 'string' && call.id !== '' ? call.id : `gen_call_${++this.#generatedIds}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args),
    };
  }
}

/** GET /models: ids, tool support, and per-token prices. */
export async function fetchModelCatalog(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): Promise<Map<string, CatalogModel>> {
  const json = await request(endpoint(o), 'GET', '/models', undefined);
  const data = isPlainObject(json) ? json.data : undefined;
  if (!Array.isArray(data)) throw new ProviderError('OpenRouter: malformed model catalog (no data array)', false);
  const out = new Map<string, CatalogModel>();
  for (const m of data) {
    if (!isPlainObject(m)) continue;
    const id = m.id;
    if (typeof id !== 'string') continue;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const pricing = isPlainObject(m.pricing) ? m.pricing : {};
    const prompt = validPrice(pricing.prompt);
    const completion = validPrice(pricing.completion);
    out.set(id, {
      id,
      supportsTools: params.includes('tools'),
      price: prompt !== null && completion !== null ? { prompt, completion } : null,
    });
  }
  return out;
}

function endpoint(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): Endpoint {
  return {
    apiKey: o.apiKey,
    baseUrl: (o.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, ''),
    requestTimeoutMs: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

async function request(ep: Endpoint, method: 'GET' | 'POST', path: string, body: JsonObject | undefined, signal?: AbortSignal): Promise<unknown> {
  const redact = (s: string) => s.split(ep.apiKey).join('[redacted]');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ep.requestTimeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let status: number;
  let text: string;
  try {
    const res = await fetch(`${ep.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'mcp-evals' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (timedOut) throw new ProviderError(`OpenRouter request timed out after ${ep.requestTimeoutMs}ms`, true);
    if (signal?.aborted) throw new ProviderError('OpenRouter request aborted', false);
    throw new ProviderError(redact(`OpenRouter network error: ${describe(e)}`), true);
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
    const classified = classify(status, redact(message));
    throw classified;
  }
  if (!parsed) throw new ProviderError(`OpenRouter: malformed response JSON (HTTP ${status})`, false);
  if (isPlainObject(json) && isPlainObject(json.error)) {
    const err = json.error;
    err.message = redact(messageOf(err));
  }
  return json;
}

function classify(status: number, message: string): Error {
  const text = `OpenRouter ${status}: ${message}`;
  if (status === 402) return new OutOfCreditsError(text);
  if (status === 408 || status === 429 || status >= 500) return new ProviderError(text, true, status);
  return new ProviderError(text, false, status);
}

function messageOf(err: JsonObject): string {
  return typeof err.message === 'string' ? err.message : 'unknown error';
}

/** A per-token price is valid only if it is a finite number >= 0 (null, "", non-numeric and negative mean "no price"). */
function validPrice(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
}

function toWireMessage(m: ChatMessage): JsonObject {
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
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}
