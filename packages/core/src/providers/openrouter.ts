import { ConfigError, CostUnknownError, ProviderError } from '../errors.js';
import { countTokens } from '../tokens.js';
import type { ChatRequest, ChatResponse, JsonObject, ModelProvider, ToolCall } from '../types.js';
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

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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

export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  readonly #endpoint: ChatEndpoint;
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
      messages: req.messages.map((m) => toWireMessage(m, { reasoningDetails: true })),
      temperature: req.temperature,
      provider: { order: [req.providerPin], allow_fallbacks: false },
    };
    if (req.tools.length > 0) {
      body.tools = toWireTools(req.tools);
    }
    const t0 = this.#now();
    let json: unknown;
    try {
      json = await requestJson(this.#endpoint, 'POST', '/chat/completions', body, req.signal);
    } catch (e) {
      if (e instanceof AbortedAfterSend) throw this.#chargeAborted(e, req.model, body);
      throw e;
    }
    return this.#parseCompletion(json, req.model, this.#now() - t0);
  }

  /**
   * A request aborted after it was sent may still be billed. Charge a conservative estimate: the request's
   * prompt (messages + tools, o200k tokens) at the catalog prompt price. Without a price the spend is unknowable.
   */
  #chargeAborted(e: AbortedAfterSend, model: string, body: JsonObject): Error {
    const price = this.#prices[model];
    const promptPrice = price ? validPrice(price.prompt) : null;
    if (promptPrice === null) {
      return new CostUnknownError(`request to ${model} was aborted after it was sent and no catalog price is known (${e.message})`);
    }
    const estimate = countTokens(JSON.stringify({ messages: body.messages, tools: body.tools })) * promptPrice;
    return new ProviderError(e.message, e.retryable, e.status, estimate);
  }

  /** usage.cost, else catalog price × tokens; undefined when neither is available. */
  #costOf(usage: JsonObject | undefined, model: string): number | undefined {
    if (!usage) return undefined;
    if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return usage.cost;
    const price = this.#prices[model];
    if (tokensKnown(usage) && price && validPrice(price.prompt) !== null && validPrice(price.completion) !== null) {
      return (usage.prompt_tokens as number) * price.prompt + (usage.completion_tokens as number) * price.completion;
    }
    return undefined;
  }

  #parseCompletion(json: unknown, model: string, latencyMs: number): ChatResponse {
    if (!isPlainObject(json)) throw new ProviderError('OpenRouter: malformed response (not a JSON object)', false);
    const error = json.error;
    const choices = json.choices;
    const usageObj = isPlainObject(json.usage) ? json.usage : undefined;
    // A 200 can still carry an error: OpenRouter reports upstream failures in the body. Any reported spend still counts.
    if (isPlainObject(error) && !Array.isArray(choices)) {
      throw classifyHttpError(this.#endpoint, numberOr(error.code, 502), messageOf(error), this.#costOf(usageObj, model) ?? 0);
    }
    const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
    if (!isPlainObject(choice)) throw new ProviderError('OpenRouter: malformed response (no choices[0].message)', false);
    const msg = choice.message;
    if (!isPlainObject(msg)) throw new ProviderError('OpenRouter: malformed response (no choices[0].message)', false);
    if (choice.finish_reason === 'error') {
      throw new ProviderError(
        `OpenRouter: generation interrupted: ${isPlainObject(error) ? messageOf(error) : 'unknown error'}`,
        true,
        502,
        this.#costOf(usageObj, model) ?? 0,
      );
    }
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const usage = usageObj ?? {};
    const costUsd = this.#costOf(usageObj, model);
    if (costUsd === undefined) {
      const priced = this.#prices[model];
      const hasPrice = priced !== undefined && validPrice(priced.prompt) !== null && validPrice(priced.completion) !== null;
      throw new CostUnknownError(hasPrice ? `usage.cost missing and token counts missing for ${model}` : `usage.cost missing and no catalog price for ${model}`);
    }
    const servedBy = json.provider;
    const metadata: JsonObject = {};
    if (msg.reasoning !== undefined && msg.reasoning !== null) metadata.reasoning = msg.reasoning;
    if (msg.reasoning_details !== undefined && msg.reasoning_details !== null) metadata.reasoning_details = msg.reasoning_details;
    return {
      content: typeof msg.content === 'string' ? msg.content : null,
      toolCalls: rawCalls.map((c: unknown) => this.#toolCall(c)),
      usage: { promptTokens: numberOr(usage.prompt_tokens, 0), completionTokens: numberOr(usage.completion_tokens, 0), costUsd },
      latencyMs,
      ...(typeof servedBy === 'string' ? { servedBy } : {}),
      ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
    };
  }

  #toolCall(c: unknown): ToolCall {
    // Some providers omit ids; tool results must still reference a unique one.
    return parseToolCall(c, () => `gen_call_${++this.#generatedIds}`);
  }
}

/** GET /models: ids, tool support, and per-token prices. */
export async function fetchModelCatalog(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): Promise<Map<string, CatalogModel>> {
  const json = await requestJson(endpoint(o), 'GET', '/models', undefined);
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

function endpoint(o: { apiKey: string; baseUrl?: string; requestTimeoutMs?: number }): ChatEndpoint {
  return {
    label: 'OpenRouter',
    apiKey: o.apiKey,
    baseUrl: trimBaseUrl(o.baseUrl ?? OPENROUTER_BASE_URL),
    requestTimeoutMs: o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    headers: { 'X-Title': 'mcp-evals' },
    creditErrors: true,
    errorBodyCostUsd: (json) => {
      const usage = isPlainObject(json) && isPlainObject(json.usage) ? json.usage : undefined;
      return usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost > 0 ? usage.cost : 0;
    },
  };
}

/** A per-token price is valid only if it is a finite number >= 0 (null, "", non-numeric and negative mean "no price"). */
function validPrice(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() === '') return null;
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function tokensKnown(usage: JsonObject): boolean {
  return [usage.prompt_tokens, usage.completion_tokens].every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0);
}
