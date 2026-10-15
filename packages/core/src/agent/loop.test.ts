import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript } from '../providers/mock.js';
import { convertTools } from '../tools/convert.js';
import type { ModelProvider } from '../types.js';
import { estimateTokens } from '../util.js';
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
    expect(r.contextTokens).toBe(estimateTokens('hello') + estimateTokens('x'.repeat(40)));
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
});
