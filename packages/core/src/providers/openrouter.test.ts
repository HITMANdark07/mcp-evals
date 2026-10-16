import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { completion, startFakeOpenRouter, toolCall, type FakeOpenRouter, type FakeOpenRouterOptions } from '../../test/fixtures/fake-openrouter.js';
import { ConfigError, CostUnknownError, OutOfCreditsError, ProviderError } from '../errors.js';
import { countTokens } from '../tokens.js';
import type { ChatRequest } from '../types.js';
import { fetchModelCatalog, OpenRouterProvider } from './openrouter.js';

const KEY = 'sk-or-test-SECRET-123';
let fake: FakeOpenRouter | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const PRICES = { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } };

async function setup(opts: FakeOpenRouterOptions = {}, requestTimeoutMs = 2000, prices?: typeof PRICES) {
  const f = await startFakeOpenRouter(opts);
  fake = f;
  return { fake: f, provider: new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, requestTimeoutMs, ...(prices ? { prices } : {}) }) };
}

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'acme/model-a',
  providerPin: 'acme',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'find it' }],
  tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
  temperature: 0,
  ...over,
});

describe('OpenRouterProvider.chat', () => {
  it('sends an OpenAI-format request pinned to one provider and parses the reply', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({
      json: completion(
        { content: 'thinking', tool_calls: [toolCall('call_1', 'echo', { text: 'hi' })] },
        { prompt_tokens: 120, completion_tokens: 7, cost: 0.0021 },
        'Anthropic',
      ),
    });
    const res = await provider.chat(
      req({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'find it' },
          { role: 'assistant', content: null, toolCalls: [{ id: 'call_0', name: 'echo', arguments: '{"text":"a"}' }] },
          { role: 'tool', toolCallId: 'call_0', content: 'a' },
        ],
      }),
    );
    expect(provider.name).toBe('openrouter');
    expect(res).toMatchObject({
      content: 'thinking',
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }],
      usage: { promptTokens: 120, completionTokens: 7, costUsd: 0.0021 },
      servedBy: 'Anthropic',
    });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    const [sent] = fake.chatRequests();
    expect(sent!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent!.body).toEqual({
      model: 'acme/model-a',
      temperature: 0,
      provider: { order: ['acme'], allow_fallbacks: false },
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'find it' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'echo', arguments: '{"text":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_0', content: 'a' },
      ],
    });
  });

  it('omits tools when the run has none', async () => {
    const { fake, provider } = await setup();
    await provider.chat(req({ tools: [] }));
    expect(fake.chatRequests()[0]!.body).not.toHaveProperty('tools');
  });

  it('classifies HTTP errors: 408/429/5xx retryable, other 4xx not, 402 out of credits', async () => {
    const { fake, provider } = await setup();
    const cases: [number, boolean][] = [[408, true], [429, true], [500, true], [503, true], [400, false], [401, false], [403, false], [404, false]];
    for (const [status, retryable] of cases) {
      fake.enqueue({ status, json: { error: { code: status, message: `status ${status}` } } });
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable, status });
    }
    fake.enqueue({ status: 402, json: { error: { code: 402, message: 'Insufficient credits' } } });
    const credits = await provider.chat(req()).catch((e: unknown) => e);
    expect(credits).toBeInstanceOf(OutOfCreditsError);
    expect((credits as Error).message).toMatch(/Insufficient credits/);
  });

  it('treats malformed JSON and a missing choices[0].message as non-retryable', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({ raw: '{"choices": [' }, { json: { id: 'x' } });
    for (let i = 0; i < 2; i++) {
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ retryable: false, message: expect.stringMatching(/malformed/) });
    }
  });

  // Review Focus 1
  it('classifies a 200 whose body is an error (or an interrupted generation) by error.code', async () => {
    const { fake, provider } = await setup();
    const interrupted = completion({ content: 'partial' }) as { choices: Array<{ finish_reason: string }> };
    interrupted.choices[0]!.finish_reason = 'error';
    fake.enqueue(
      { json: { error: { code: 502, message: 'upstream down' } } },
      { json: { error: { code: 402, message: 'out of credits' } } },
      { json: interrupted },
    );
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: true, status: 502 });
    expect(await provider.chat(req()).catch((e: unknown) => e)).toBeInstanceOf(OutOfCreditsError);
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: true });
  });

  it('times out slow requests as retryable', async () => {
    const { fake, provider } = await setup({}, 50, PRICES);
    fake.enqueue({ delayMs: 1000 });
    const err = await provider.chat(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true, message: expect.stringMatching(/timed out after 50ms/) });
  });

  it('honors ChatRequest.signal', async () => {
    const { fake, provider } = await setup({}, 2000, PRICES);
    fake.enqueue({ delayMs: 1000 });
    const controller = new AbortController();
    const t0 = Date.now();
    const pending = provider.chat(req({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: false, message: expect.stringMatching(/aborted/) });
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it('reports network errors as retryable', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const provider = new OpenRouterProvider({ apiKey: KEY, baseUrl: `http://127.0.0.1:${port}/api/v1` });
    const err = await provider.chat(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true, message: expect.stringMatching(/network error/) });
  });

  // Review Focus 2
  it('falls back to catalog prices when usage.cost is missing, so the budget cap still holds', async () => {
    const f = await startFakeOpenRouter();
    fake = f;
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, prices: { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } } });
    f.enqueue({ json: completion({ content: 'ok' }, { prompt_tokens: 1000, completion_tokens: 500 }) });
    expect((await priced.chat(req())).usage.costUsd).toBeCloseTo(0.002, 12);
    f.enqueue({ json: completion({ content: 'ok' }, { prompt_tokens: 1000, completion_tokens: 500, cost: 0 }) });
    expect((await priced.chat(req())).usage.costUsd).toBe(0);
  });

  it('throws CostUnknownError (not a ProviderError) naming the cause when cost cannot be determined', async () => {
    const { fake, provider } = await setup();
    const noCost = completion({ content: 'ok' }, { prompt_tokens: 10, completion_tokens: 1 });
    const noUsage = completion({ content: 'ok' }) as Record<string, unknown>;
    delete noUsage.usage;
    fake.enqueue({ json: noCost }, { json: noUsage });
    for (let i = 0; i < 2; i++) {
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CostUnknownError);
      expect(err).not.toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ reason: 'usage.cost missing and no catalog price for acme/model-a' });
    }
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: fake.baseUrl, prices: { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } } });
    fake.enqueue({ json: noUsage }, { json: completion({ content: 'ok' }, { prompt_tokens: 10, completion_tokens: 1, cost: -1 }) });
    expect(await priced.chat(req()).catch((e: unknown) => e)).toMatchObject({
      name: 'CostUnknownError',
      reason: 'usage.cost missing and token counts missing for acme/model-a',
    });
    expect((await priced.chat(req())).usage.costUsd).toBeCloseTo(0.000012, 12);
  });

  it('requires both token counts for the priced fallback', async () => {
    const f = await startFakeOpenRouter();
    fake = f;
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, prices: { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } } });
    f.enqueue({ json: completion({ content: 'ok' }, {}) }, { json: completion({ content: 'ok' }, { prompt_tokens: 10 }) });
    for (let i = 0; i < 2; i++) {
      expect(await priced.chat(req()).catch((e: unknown) => e)).toMatchObject({
        name: 'CostUnknownError',
        reason: 'usage.cost missing and token counts missing for acme/model-a',
      });
    }
  });

  it('charges a conservative prompt-token estimate for a request aborted after it was sent', async () => {
    const f = await startFakeOpenRouter();
    fake = f;
    const price = { prompt: 0.000001, completion: 0.000002 };
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, prices: { 'acme/model-a': price }, requestTimeoutMs: 2000 });
    f.enqueue({ delayMs: 1000 });
    const controller = new AbortController();
    const pending = priced.chat(req({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const err = await pending.catch((e: unknown) => e);
    const sent = f.chatRequests()[0]!.body;
    const estimate = countTokens(JSON.stringify({ messages: sent.messages, tools: sent.tools })) * price.prompt;
    expect(estimate).toBeGreaterThan(0);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: false, message: expect.stringMatching(/aborted/) });
    expect((err as ProviderError).costUsd).toBeCloseTo(estimate, 15);
  });

  it('charges the same estimate when the request times out (retryable)', async () => {
    const f = await startFakeOpenRouter();
    fake = f;
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: f.baseUrl, prices: { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } }, requestTimeoutMs: 50 });
    f.enqueue({ delayMs: 1000 });
    const err = await priced.chat(req()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true, message: expect.stringMatching(/timed out/) });
    expect((err as ProviderError).costUsd).toBeGreaterThan(0);
  });

  it('throws CostUnknownError for an aborted request when no price is known, and charges nothing if it was never sent', async () => {
    const { fake, provider } = await setup({}, 50);
    fake.enqueue({ delayMs: 1000 });
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({
      name: 'CostUnknownError',
      reason: expect.stringMatching(/^request to acme\/model-a was aborted after it was sent and no catalog price is known/),
    });
    const controller = new AbortController();
    controller.abort();
    const priced = new OpenRouterProvider({ apiKey: KEY, baseUrl: fake.baseUrl, prices: { 'acme/model-a': { prompt: 0.000001, completion: 0.000002 } } });
    const before = fake.chatRequests().length;
    const err = await priced.chat(req({ signal: controller.signal })).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', costUsd: 0 });
    expect(fake.chatRequests()).toHaveLength(before);
  });

  it('carries usage.cost from error bodies (200 error object, finish_reason error, HTTP error) on the thrown error', async () => {
    const { fake, provider } = await setup();
    const interrupted = completion({ content: 'partial' }, { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 }) as { choices: Array<{ finish_reason: string }> };
    interrupted.choices[0]!.finish_reason = 'error';
    fake.enqueue(
      { json: { error: { code: 502, message: 'upstream down' }, usage: { prompt_tokens: 100, completion_tokens: 0, cost: 0.01 } } },
      { json: interrupted },
      { status: 500, json: { error: { code: 500, message: 'boom' }, usage: { cost: 0.01 } } },
    );
    for (let i = 0; i < 3; i++) {
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'ProviderError', retryable: true });
      expect((err as ProviderError).costUsd).toBe(0.01);
    }
  });

  it('treats 403 key or credit limit errors as out of credits', async () => {
    const { fake, provider } = await setup();
    fake.enqueue(
      { status: 403, json: { error: { code: 403, message: 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys' } } },
      { status: 403, json: { error: { code: 403, message: 'This request exceeds your CREDIT LIMIT' } } },
      { status: 403, json: { error: { code: 403, message: 'Forbidden: model not allowed for this key' } } },
    );
    expect(await provider.chat(req()).catch((e: unknown) => e)).toBeInstanceOf(OutOfCreditsError);
    expect(await provider.chat(req()).catch((e: unknown) => e)).toBeInstanceOf(OutOfCreditsError);
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: false, status: 403 });
  });

  it('carries reasoning metadata opaquely and sends reasoning_details back on later turns', async () => {
    const { fake, provider } = await setup();
    const details = [{ type: 'reasoning.encrypted', data: 'opaque==', id: 'r1', format: 'anthropic-claude-v1', index: 0 }];
    const reply = completion({ tool_calls: [toolCall('call_1', 'echo', { text: 'hi' })] }) as { choices: Array<{ message: Record<string, unknown> }> };
    reply.choices[0]!.message.reasoning = 'I should echo.';
    reply.choices[0]!.message.reasoning_details = details;
    fake.enqueue({ json: reply });
    const res = await provider.chat(req());
    expect(res.providerMetadata).toEqual({ reasoning: 'I should echo.', reasoning_details: details });
    await provider.chat(req({
      messages: [
        { role: 'user', content: 'find it' },
        { role: 'assistant', content: null, toolCalls: res.toolCalls, providerMetadata: res.providerMetadata },
        { role: 'tool', toolCallId: 'call_1', content: 'hi' },
      ],
    }));
    expect(fake.chatRequests()[1]!.body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }],
      reasoning_details: details,
    });
    // No metadata → no extra fields.
    fake.enqueue({ json: completion({ content: 'plain' }) });
    expect((await provider.chat(req())).providerMetadata).toBeUndefined();
  });

  it('redacts the key before truncating long error bodies', async () => {
    const { fake, provider } = await setup();
    const message = 'x'.repeat(290) + KEY + 'y'.repeat(100);
    fake.enqueue({ status: 400, raw: message });
    const err = (await provider.chat(req()).catch((e: unknown) => e)) as Error;
    for (let n = 8; n <= KEY.length; n++) expect(err.message).not.toContain(KEY.slice(0, n));
  });

  it('refuses a model without a provider pin before sending anything', async () => {
    const { fake, provider } = await setup();
    const err = await provider.chat(req({ providerPin: undefined })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/no provider pin/);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('never exposes the API key, even when the server echoes it', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({ status: 401, json: { error: { code: 401, message: `bad key ${KEY}` } } });
    const err = (await provider.chat(req()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[redacted]');
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(Object.values(provider).join(' ')).not.toContain(KEY);
  });

  it('fills missing tool-call ids and stringifies object arguments', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({
      json: completion({
        tool_calls: [
          { type: 'function', function: { name: 'echo', arguments: { text: 'x' } } },
          { id: '', type: 'function', function: { name: 'echo', arguments: '' } },
        ],
      }),
    });
    const res = await provider.chat(req());
    expect(res.toolCalls.map((c) => c.arguments)).toEqual(['{"text":"x"}', '']);
    expect(res.toolCalls.every((c) => c.id.length > 0)).toBe(true);
    expect(new Set(res.toolCalls.map((c) => c.id)).size).toBe(2);
  });
});

describe('fetchModelCatalog', () => {
  it('reads ids, tool support and per-token prices', async () => {
    const { fake } = await setup();
    const catalog = await fetchModelCatalog({ apiKey: KEY, baseUrl: fake.baseUrl });
    expect(catalog.get('acme/model-a')).toEqual({ id: 'acme/model-a', supportsTools: true, price: { prompt: 0.000001, completion: 0.000002 } });
    expect(catalog.get('acme/no-tools')?.supportsTools).toBe(false);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/models' });
  });

  it('treats null, empty and negative prices as no price', async () => {
    const { fake } = await setup({
      models: [
        { id: 'a/n', pricing: { prompt: null, completion: '0.1' } },
        { id: 'a/e', pricing: { prompt: '', completion: '' } },
        { id: 'a/ws', pricing: { prompt: '  ', completion: ' ' } },
        { id: 'a/neg', pricing: { prompt: '-1', completion: '-1' } },
      ],
    });
    const catalog = await fetchModelCatalog({ apiKey: KEY, baseUrl: fake.baseUrl });
    for (const id of ['a/n', 'a/e', 'a/ws', 'a/neg']) expect(catalog.get(id)?.price).toBeNull();
  });

  it('marks unparseable prices as null', async () => {
    const { fake } = await setup({ models: [{ id: 'x/y', supported_parameters: ['tools'], pricing: { prompt: 'n/a' } }] });
    expect((await fetchModelCatalog({ apiKey: KEY, baseUrl: fake.baseUrl })).get('x/y')).toEqual({ id: 'x/y', supportsTools: true, price: null });
  });
});
