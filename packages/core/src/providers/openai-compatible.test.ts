import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
// The fake OpenRouter speaks the plain OpenAI chat format too; these tests only use that part of it.
import { completion, startFakeOpenRouter, toolCall, type FakeOpenRouter, type FakeOpenRouterOptions } from '../../test/fixtures/fake-openrouter.js';
import { ConfigError, CostUnknownError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatRequest } from '../types.js';
import { fetchServedModels, OpenAICompatibleProvider } from './openai-compatible.js';

const KEY = 'local-test-SECRET-456';
let fake: FakeOpenRouter | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(opts: FakeOpenRouterOptions = {}, o: { apiKey?: string; requestTimeoutMs?: number } = {}) {
  const f = await startFakeOpenRouter({ models: [{ id: 'qwen3:8b' }, { id: 'llama3.2:1b' }], ...opts });
  fake = f;
  return { fake: f, provider: new OpenAICompatibleProvider({ baseUrl: f.baseUrl, requestTimeoutMs: o.requestTimeoutMs ?? 2000, ...(o.apiKey ? { apiKey: o.apiKey } : {}) }) };
}

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'qwen3:8b',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'find it' }],
  tools: [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
  temperature: 0,
  ...over,
});

function withoutUsage(body: unknown): unknown {
  const b = body as Record<string, unknown>;
  delete b.usage;
  return b;
}

describe('OpenAICompatibleProvider.chat', () => {
  it('sends a plain OpenAI request (no provider pinning, no OpenRouter fields, no auth without a key)', async () => {
    const { fake, provider } = await setup();
    await provider.chat(
      req({
        providerPin: 'acme', // a suite pin is ignored
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'find it' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'call_0', name: 'echo', arguments: '{"text":"a"}' }],
            providerMetadata: { reasoning_details: [{ type: 'reasoning.text', text: 'x' }] },
          },
          { role: 'tool', toolCallId: 'call_0', content: 'a' },
        ],
      }),
    );
    expect(provider.name).toBe('openai-compatible');
    const [sent] = fake.chatRequests();
    expect(sent!.method).toBe('POST');
    expect(sent!.path).toBe('/api/v1/chat/completions');
    expect(sent!.headers.authorization).toBeUndefined();
    expect(sent!.headers['x-title']).toBeUndefined();
    expect(sent!.body).toEqual({
      model: 'qwen3:8b',
      temperature: 0,
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'find it' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'echo', arguments: '{"text":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_0', content: 'a' },
      ],
    });
  });

  it('sends the API key as a Bearer token only when one is set, and never exposes it', async () => {
    const { fake, provider } = await setup({}, { apiKey: KEY });
    await provider.chat(req());
    expect(fake.chatRequests()[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    fake.enqueue({ status: 401, json: { error: { code: 401, message: `bad key ${KEY}` } } });
    const err = (await provider.chat(req()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[redacted]');
    expect(JSON.stringify(provider)).not.toContain(KEY);
    expect(Object.values(provider).join(' ')).not.toContain(KEY);
    const blank = new OpenAICompatibleProvider({ baseUrl: fake.baseUrl, apiKey: '  ' });
    await blank.chat(req());
    expect(fake.chatRequests().at(-1)!.headers.authorization).toBeUndefined();
  });

  it('omits tools when the run has none', async () => {
    const { fake, provider } = await setup();
    await provider.chat(req({ tools: [] }));
    expect(fake.chatRequests()[0]!.body).not.toHaveProperty('tools');
  });

  it('round-trips tool calls: parses them, fills missing ids, and sends results back by id', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({
      json: completion({
        content: null,
        tool_calls: [toolCall('call_1', 'echo', { text: 'hi' }), { type: 'function', function: { name: 'echo', arguments: { text: 'x' } } }],
      }),
    });
    const res = await provider.chat(req());
    expect(res.content).toBeNull();
    expect(res.toolCalls[0]).toEqual({ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' });
    expect(res.toolCalls[1]).toMatchObject({ name: 'echo', arguments: '{"text":"x"}', id: expect.stringMatching(/^gen_call_/) });
    expect(res.providerMetadata).toBeUndefined();
    fake.enqueue({ json: completion({ content: 'hi' }) });
    const final = await provider.chat(
      req({
        messages: [
          { role: 'user', content: 'find it' },
          { role: 'assistant', content: null, toolCalls: res.toolCalls },
          { role: 'tool', toolCallId: 'call_1', content: 'hi' },
          { role: 'tool', toolCallId: res.toolCalls[1]!.id, content: 'x' },
        ],
      }),
    );
    expect(final.content).toBe('hi');
    const sent = fake.chatRequests()[1]!.body.messages;
    expect(sent[1].tool_calls.map((c: { id: string }) => c.id)).toEqual(['call_1', res.toolCalls[1]!.id]);
    expect(sent.slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'hi' },
      { role: 'tool', tool_call_id: res.toolCalls[1]!.id, content: 'x' },
    ]);
  });

  it('reads tokens from usage, records 0 when usage is missing, and always costs $0', async () => {
    const { fake, provider } = await setup();
    fake.enqueue(
      { json: completion({ content: 'a' }, { prompt_tokens: 120, completion_tokens: 7 }) },
      { json: withoutUsage(completion({ content: 'b' })) },
      { json: completion({ content: 'c' }, { prompt_tokens: 5 }) },
      // A server that does report a cost is still not priced: cost is not measured for this provider.
      { json: completion({ content: 'd' }, { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 }) },
    );
    expect((await provider.chat(req())).usage).toEqual({ promptTokens: 120, completionTokens: 7, costUsd: 0 });
    expect((await provider.chat(req())).usage).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 });
    expect((await provider.chat(req())).usage).toEqual({ promptTokens: 5, completionTokens: 0, costUsd: 0 });
    expect((await provider.chat(req())).usage).toEqual({ promptTokens: 1, completionTokens: 1, costUsd: 0 });
  });

  it('classifies HTTP errors like OpenRouter (408/429/5xx retryable, 4xx not), without credit errors', async () => {
    const { fake, provider } = await setup();
    const cases: [number, boolean][] = [[408, true], [429, true], [500, true], [503, true], [400, false], [401, false], [402, false], [403, false], [404, false]];
    for (const [status, retryable] of cases) {
      fake.enqueue({ status, json: { error: { code: status, message: `status ${status} key limit` } } });
      const err = await provider.chat(req()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).not.toBeInstanceOf(OutOfCreditsError);
      expect(err).toMatchObject({ retryable, status, costUsd: 0 });
    }
    // Ollama-style plain-text error body.
    fake.enqueue({ status: 404, raw: 'model "nope" not found, try pulling it first' });
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ retryable: false, message: expect.stringMatching(/404: model "nope" not found/) });
  });

  it('treats malformed JSON, a missing message, and a 200 error body like OpenRouter', async () => {
    const { fake, provider } = await setup();
    fake.enqueue({ raw: '{"choices": [' }, { json: { id: 'x' } }, { json: { error: { code: 503, message: 'loading model' } } });
    for (let i = 0; i < 2; i++) {
      expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: false, message: expect.stringMatching(/malformed/) });
    }
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: true, status: 503 });
  });

  it('times out as retryable and an aborted request costs $0, never an unknown cost', async () => {
    const { fake, provider } = await setup({}, { requestTimeoutMs: 50 });
    fake.enqueue({ delayMs: 1000 });
    const timedOut = await provider.chat(req()).catch((e: unknown) => e);
    expect(timedOut).toMatchObject({ name: 'ProviderError', retryable: true, costUsd: 0, message: expect.stringMatching(/timed out after 50ms/) });
    expect(timedOut).not.toBeInstanceOf(CostUnknownError);

    const slow = new OpenAICompatibleProvider({ baseUrl: fake.baseUrl, requestTimeoutMs: 2000 });
    fake.enqueue({ delayMs: 1000 });
    const controller = new AbortController();
    const pending = slow.chat(req({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const aborted = await pending.catch((e: unknown) => e);
    expect(aborted).toMatchObject({ name: 'ProviderError', retryable: false, costUsd: 0, message: expect.stringMatching(/aborted/) });
  });

  it('reports network errors as retryable', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1` });
    expect(await provider.chat(req()).catch((e: unknown) => e)).toMatchObject({ name: 'ProviderError', retryable: true, message: expect.stringMatching(/network error/) });
  });

  it('rejects an invalid or non-http base URL', () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: 'localhost:11434' })).toThrow(ConfigError);
    expect(() => new OpenAICompatibleProvider({ baseUrl: 'not a url' })).toThrow(/invalid base URL/);
    expect(() => new OpenAICompatibleProvider({ baseUrl: 'file:///tmp/x' })).toThrow(/must be http/);
  });
});

describe('fetchServedModels', () => {
  it('lists the ids from GET {base}/models, with a trailing slash in the base URL tolerated', async () => {
    const { fake } = await setup({}, {});
    const ids = await fetchServedModels({ baseUrl: `${fake.baseUrl}/`, apiKey: KEY });
    expect([...ids]).toEqual(['qwen3:8b', 'llama3.2:1b']);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/models' });
    expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('rejects a malformed model list', async () => {
    const { fake } = await setup({ models: 'nope' as unknown as unknown[] });
    expect(await fetchServedModels({ baseUrl: fake.baseUrl }).catch((e: unknown) => e)).toMatchObject({
      name: 'ProviderError',
      message: expect.stringMatching(/malformed model list/),
    });
  });
});
