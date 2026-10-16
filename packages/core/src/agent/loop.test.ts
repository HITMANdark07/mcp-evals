import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript } from '../providers/mock.js';
import { convertTools } from '../tools/convert.js';
import { CostUnknownError, InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import { completion, startFakeOpenRouter, toolCall } from '../../test/fixtures/fake-openrouter.js';
import type { ChatRequest, ModelProvider } from '../types.js';
import { countTokens } from '../tokens.js';
import { runAgentLoop, type AgentLoopOptions } from './loop.js';

const connect = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function setup(steps: unknown[], over: Partial<AgentLoopOptions> = {}) {
  const connection = await connect({ args: [], env: {}, headers: {}, command: 'x' }, { cwd: await mkdtemp(join(tmpdir(), 'loop-')), vars: {} });
  const tools = convertTools(await connection.listTools());
  const provider = new MockProvider(parseMockScript({ entries: [{ match: 'TASK', steps }] }));
  const opts: AgentLoopOptions = { provider, connection, tools, model: 'm/a', prompt: 'TASK', maxSteps: 5, timeoutMs: 5000, temperature: 0, ...over };
  return { opts, connection };
}

describe('runAgentLoop', () => {
  it('calls tools, counts context tokens, and returns the final answer', async () => {
    const { opts, connection } = await setup([
      { toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }, { name: 'big', arguments: { size: 40 } }] },
      { content: 'all done' },
    ]);
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('final_answer');
    expect(r.finalAnswer).toBe('all done');
    expect(r.steps).toBe(2);
    expect(r.contextTokens).toBe(countTokens('hello') + countTokens('x'.repeat(40)));
    expect(r.costUsd).toBeCloseTo(0.002, 6);
    expect(r.events.map((e) => e.type)).toEqual(['model_call', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'model_call', 'final_answer']);
    await connection.close();
  });

  it('feeds tool errors back and continues', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'fail' }] }, { content: 'recovered' }]);
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('final_answer');
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true, tool: 'fail' });
  });

  // Review Focus 1
  it('maps sanitized function names back to MCP names', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'dotted_name' }] }, { content: 'ok' }]);
    const r = await runAgentLoop(opts);
    expect(r.events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'dotted.name', isError: false });
  });

  it('stops at max_steps', async () => {
    const step = { toolCalls: [{ name: 'echo', arguments: { text: 'again' } }] };
    const { opts } = await setup([step, step, step, step], { maxSteps: 3 });
    const r = await runAgentLoop(opts);
    expect(r).toMatchObject({ end: 'max_steps', steps: 3, finalAnswer: null });
  });

  it('ends with invalid_tool_call for unknown tools and invalid JSON args', async () => {
    const unknown = await runAgentLoop((await setup([{ toolCalls: [{ name: 'nope' }] }])).opts);
    expect(unknown.end).toBe('invalid_tool_call');
    expect(unknown.failReason).toMatch(/unknown tool "nope"/);
    const badJson = await runAgentLoop((await setup([{ toolCalls: [{ name: 'echo', arguments: '{oops' }] }])).opts);
    expect(badJson.end).toBe('invalid_tool_call');
    expect(badJson.failReason).toMatch(/invalid JSON arguments/);
  });

  it('turns ProviderErrors into infra_error', async () => {
    const r = await runAgentLoop((await setup([{ error: { message: 'rate limited', retryable: true } }])).opts);
    expect(r.end).toBe('infra_error');
    expect(r.infraError).toMatchObject({ kind: 'provider', retryable: true });
  });

  it('respects the budget check before each model call', async () => {
    const { opts } = await setup([{ content: 'never' }], { shouldStop: () => true });
    const r = await runAgentLoop(opts);
    expect(r).toMatchObject({ end: 'budget', steps: 0 });
  });

  it('times out a hanging model call', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const hang: ModelProvider = { name: 'hang', chat: () => new Promise(() => {}) };
    const r = await runAgentLoop({ ...opts, provider: hang, timeoutMs: 50 });
    expect(r.end).toBe('timeout');
  });

  it('times out when the provider honors the abort signal', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const honoring: ModelProvider = {
      name: 'honor',
      chat: (req) => new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    };
    const r = await runAgentLoop({ ...opts, provider: honoring, timeoutMs: 50 });
    expect(r.end).toBe('timeout');
  });

  it('bounds tool calls by the run deadline', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'slow', arguments: { ms: 500 } }] }, { content: 'x' }], { timeoutMs: 100 });
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('timeout');
  });

  it('classifies unexpected provider errors as non-retryable infra_error', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const bad: ModelProvider = { name: 'bad', chat: () => Promise.reject(new TypeError('fetch failed')) };
    const r = await runAgentLoop({ ...opts, provider: bad });
    expect(r.end).toBe('infra_error');
    expect(r.infraError).toMatchObject({ kind: 'provider', retryable: false });
  });

  it('classifies unexpected tool errors as non-retryable infra_error', async () => {
    const { opts, connection } = await setup([{ toolCalls: [{ name: 'echo', arguments: { text: 'a' } }] }]);
    const r = await runAgentLoop({ ...opts, connection: { ...connection, callTool: async () => { throw new Error('weird'); } } });
    expect(r.end).toBe('infra_error');
    expect(r.infraError).toMatchObject({ kind: 'server', retryable: false });
  });

  it('ends with infra_error when the server connection closes mid-task', async () => {
    const { opts, connection } = await setup([{ toolCalls: [{ name: 'echo', arguments: { text: 'a' } }] }]);
    const r = await runAgentLoop({
      ...opts,
      connection: { ...connection, callTool: async () => { throw new InfraError('server', 'connection closed', true); } },
    });
    expect(r.end).toBe('infra_error');
    expect(r.infraError).toMatchObject({ kind: 'server', retryable: true });
    expect(r.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('checks the deadline between iterations', async () => {
    const step = { toolCalls: [{ name: 'echo', arguments: { text: 'a' }}] };
    const { opts, connection } = await setup([step, { content: 'never' }], { timeoutMs: 1000 });
    let clock = 0;
    const wrapped = { ...connection, callTool: async (...a: Parameters<typeof connection.callTool>) => { const r = await connection.callTool(...a); clock += 2000; return r; } };
    const r = await runAgentLoop({ ...opts, connection: wrapped, now: () => clock });
    expect(r.end).toBe('timeout');
    expect(r.events.filter((e) => e.type === 'model_call')).toHaveLength(1);
    expect(r.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });

  it('checks budget before max_steps', async () => {
    const { opts } = await setup([{ content: 'x' }], { maxSteps: 0, shouldStop: () => true });
    expect((await runAgentLoop(opts)).end).toBe('budget');
  });

  it('ends with tool_timeout (a model fail, not infra) when one call exceeds the tool timeout', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'slow', arguments: { ms: 400 } }] }, { content: 'never' }], {
      toolTimeoutMs: 50,
      timeoutMs: 5000,
    });
    const r = await runAgentLoop(opts);
    expect(r.end).toBe('tool_timeout');
    expect(r.infraError).toBeUndefined();
    expect(r.failReason).toBe('tool "slow" exceeded the 50ms tool timeout');
    expect(r.events.at(-1)).toMatchObject({ type: 'error', kind: 'tool_timeout' });
  });

  it('still ends with timeout when the run deadline, not the tool timeout, cut the call short', async () => {
    const { opts } = await setup([{ toolCalls: [{ name: 'slow', arguments: { ms: 400 } }] }, { content: 'never' }], {
      toolTimeoutMs: 60_000,
      timeoutMs: 100,
    });
    expect((await runAgentLoop(opts)).end).toBe('timeout');
  });

  it('passes the provider pin and records who served each call', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const seen: ChatRequest[] = [];
    const served: ModelProvider = {
      name: 'served',
      chat: async (req) => {
        seen.push(req);
        return { content: 'done', toolCalls: [], usage: { promptTokens: 9, completionTokens: 1, costUsd: 0.001 }, latencyMs: 1, servedBy: 'Acme' };
      },
    };
    const r = await runAgentLoop({ ...opts, provider: served, providerPin: 'acme' });
    expect(seen[0]!.providerPin).toBe('acme');
    expect(r.events[0]).toMatchObject({ type: 'model_call', servedBy: 'Acme' });
  });

  it('ends like a budget stop, flagged outOfCredits, on OutOfCreditsError', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const broke: ModelProvider = { name: 'broke', chat: () => Promise.reject(new OutOfCreditsError('OpenRouter 402: no credits')) };
    const r = await runAgentLoop({ ...opts, provider: broke });
    expect(r).toMatchObject({ end: 'budget', outOfCredits: true, failReason: 'OpenRouter 402: no credits' });
    expect(r.infraError).toBeUndefined();
  });

  it('ends like a budget stop, flagged costUnknown with the reason, on CostUnknownError, keeping known spend', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    let calls = 0;
    const provider: ModelProvider = {
      name: 'unknown-cost',
      chat: async () => {
        if (calls++ === 0) return { content: null, toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"a"}' }], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.002 }, latencyMs: 1 };
        throw new CostUnknownError('usage.cost missing and no catalog price for m/a', 0.0005);
      },
    };
    const r = await runAgentLoop({ ...opts, provider });
    expect(r).toMatchObject({ end: 'budget', costUnknown: 'usage.cost missing and no catalog price for m/a' });
    expect(r.infraError).toBeUndefined();
    expect(r.outOfCredits).toBeUndefined();
    expect(r.costUsd).toBeCloseTo(0.0025, 12);
  });

  it('adds the spend carried by a provider error (an error body with usage.cost) to the run cost', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const provider: ModelProvider = { name: 'err-cost', chat: () => Promise.reject(new ProviderError('OpenRouter 502: upstream', true, 502, 0.01)) };
    const r = await runAgentLoop({ ...opts, provider });
    expect(r.end).toBe('infra_error');
    expect(r.costUsd).toBeCloseTo(0.01, 12);
    const broke: ModelProvider = { name: 'broke', chat: () => Promise.reject(new OutOfCreditsError('OpenRouter 402', 0.003)) };
    expect((await runAgentLoop({ ...opts, provider: broke })).costUsd).toBeCloseTo(0.003, 12);
  });

  it('charges the aborted call when the run times out mid-call', async () => {
    const { opts } = await setup([{ content: 'unused' }]);
    const honoring: ModelProvider = {
      name: 'honor',
      chat: (req) => new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new ProviderError('OpenRouter request aborted', false, undefined, 0.004)));
      }),
    };
    const r = await runAgentLoop({ ...opts, provider: honoring, timeoutMs: 50 });
    expect(r.end).toBe('timeout');
    expect(r.costUsd).toBeCloseTo(0.004, 12);
    const unpriced: ModelProvider = {
      name: 'unpriced',
      chat: (req) => new Promise((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new CostUnknownError('request to m/a was aborted after it was sent and no catalog price is known')));
      }),
    };
    expect(await runAgentLoop({ ...opts, provider: unpriced, timeoutMs: 50 })).toMatchObject({ end: 'budget', costUnknown: expect.stringMatching(/aborted/) });
  });

  it('charges the OpenRouter estimate for a request the run deadline aborted (fake OpenRouter)', async () => {
    const f = await startFakeOpenRouter();
    try {
      f.enqueue({ delayMs: 2000 });
      const { opts } = await setup([{ content: 'unused' }]);
      const provider = new OpenRouterProvider({ apiKey: 'sk-test', baseUrl: f.baseUrl, prices: { 'm/a': { prompt: 0.000001, completion: 0.000002 } } });
      const r = await runAgentLoop({ ...opts, provider, providerPin: 'acme', timeoutMs: 100 });
      expect(r.end).toBe('timeout');
      expect(r.costUsd).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  it('sends reasoning_details back with the assistant message on the next turn (fake OpenRouter)', async () => {
    const details = [{ type: 'reasoning.text', text: 'think', signature: 'sig==', index: 0 }];
    const first = completion({ tool_calls: [toolCall('call_1', 'echo', { text: 'hi' })] }) as { choices: Array<{ message: Record<string, unknown> }> };
    first.choices[0]!.message.reasoning_details = details;
    const f = await startFakeOpenRouter();
    try {
      f.enqueue({ json: first }, { json: completion({ content: 'done' }) });
      const { opts } = await setup([{ content: 'unused' }]);
      const provider = new OpenRouterProvider({ apiKey: 'sk-test', baseUrl: f.baseUrl });
      const r = await runAgentLoop({ ...opts, provider, providerPin: 'acme' });
      expect(r.end).toBe('final_answer');
      const assistant = f.chatRequests()[1]!.body.messages.find((m: { role: string }) => m.role === 'assistant');
      expect(assistant.reasoning_details).toEqual(details);
      expect(JSON.stringify(r.events)).not.toContain('sig==');
    } finally {
      await f.close();
    }
  });
});
