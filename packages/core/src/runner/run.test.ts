import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError, ProviderError } from '../errors.js';
import { FixtureManager } from '../fixtures/manager.js';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript, type MockScript } from '../providers/mock.js';
import { parseSuite } from '../suite/load.js';
import type { Connector, ModelProvider } from '../types.js';
import { runSuites, type RunSuitesOptions } from './run.js';

const SUITE = `
suite: demo
version: 1
servers:
  fake: { command: unused, setup: "echo prepared > setup.txt" }
models: [mock/a, mock/b]
defaults: { repeats: 2, max_steps: 4, timeout_s: 10 }
tasks:
  - id: echo
    prompt: "ECHO task"
    graders:
      - { type: tool_called, tool: echo }
      - { type: answer_contains_all, values: [hello] }
  - id: write
    prompt: "WRITE task"
    graders:
      - { type: fs_state, path: out.txt, contains: written }
      - { type: fs_state, path: setup.txt, contains: prepared }
`;

const SCRIPT: MockScript = parseMockScript({
  entries: [
    { match: 'ECHO', model: 'mock/a', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
    { match: 'ECHO', model: 'mock/b', steps: [{ content: 'I did not use tools' }] },
    { match: 'WRITE', steps: [{ toolCalls: [{ name: 'write_file', arguments: { path: 'out.txt', content: 'written' } }] }, { content: 'ok' }] },
  ],
});

const memory: Connector = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function opts(over: Partial<RunSuitesOptions> = {}): Promise<RunSuitesOptions> {
  const root = await mkdtemp(join(tmpdir(), 'runner-'));
  return {
    suites: [parseSuite(SUITE, 'demo.yaml')],
    provider: new MockProvider(SCRIPT),
    connector: memory,
    fixtures: new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: join(root, 'work') }),
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

describe('runSuites', () => {
  it('runs every server × model × task × repeat and grades each run', async () => {
    const out = await runSuites(await opts());
    expect(out.records).toHaveLength(8);
    expect(new Set(out.records.map((r) => r.runKey)).size).toBe(8);
    const byModelTask = (m: string, t: string) => out.records.filter((r) => r.model === m && r.task === t).map((r) => r.outcome);
    expect(byModelTask('mock/a', 'echo')).toEqual(['pass', 'pass']);
    expect(byModelTask('mock/b', 'echo')).toEqual(['fail', 'fail']);
    expect(byModelTask('mock/a', 'write')).toEqual(['pass', 'pass']);
    const failed = out.records.find((r) => r.model === 'mock/b' && r.task === 'echo')!;
    expect(failed.failReason).toMatch(/tool_called/);
    expect(failed.toolSelectionOk).toBe(false);
    expect(out.partial).toBe(false);
    expect(out.totalCostUsd).toBeCloseTo(out.records.reduce((s, r) => s + r.costUsd, 0), 9);
  });

  it('applies model, server, and repeat filters', async () => {
    const out = await runSuites(await opts({ models: ['mock/a'], repeats: 1 }));
    expect(out.records).toHaveLength(2);
  });

  // Review Focus 2
  it('rejects unknown model or server filters before running anything', async () => {
    const o = await opts({ models: ['mock/typo'] });
    await expect(runSuites(o)).rejects.toBeInstanceOf(ConfigError);
    await expect(runSuites(await opts({ servers: ['nope'] }))).rejects.toThrow(/Unknown server/);
  });

  it('retries retryable infra errors, then succeeds', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const flaky: ModelProvider = {
      name: 'flaky',
      chat: (req) => (calls++ === 0 ? Promise.reject(new ProviderError('503', true, 503)) : inner.chat(req)),
    };
    const sleep = vi.fn(async () => {});
    const out = await runSuites(await opts({ provider: flaky, sleep, models: ['mock/a'], repeats: 1 }));
    expect(out.records[0]).toMatchObject({ outcome: 'pass', attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('records error (not fail) after retries are exhausted or for non-retryable errors', async () => {
    const down: ModelProvider = { name: 'down', chat: () => Promise.reject(new ProviderError('500', true, 500)) };
    const sleep = vi.fn(async () => {});
    const out = await runSuites(await opts({ provider: down, sleep, retries: 2, models: ['mock/a'], repeats: 1 }));
    expect(out.records.every((r) => r.outcome === 'error')).toBe(true);
    expect(out.records[0]!.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(4);

    const fatal: ModelProvider = { name: 'fatal', chat: () => Promise.reject(new ProviderError('401', false, 401)) };
    const out2 = await runSuites(await opts({ provider: fatal, models: ['mock/a'], repeats: 1 }));
    expect(out2.records[0]).toMatchObject({ outcome: 'error', attempts: 1 });
  });

  it('stops scheduling and marks partial when the budget is spent', async () => {
    const out = await runSuites(await opts({ budgetUsd: 0.0035 }));
    expect(out.partial).toBe(true);
    expect(out.records.length).toBeLessThan(8);
    expect(out.totalCostUsd).toBeLessThanOrEqual(0.0035 + 0.001);
  });

  it('records error (does not throw) when listTools fails with a non-InfraError', async () => {
    const broken: Connector = async (server, ctx) => {
      const conn = await memory(server, ctx);
      return { ...conn, listTools: () => Promise.reject(new Error('boom')), close: () => conn.close(), stderr: () => conn.stderr() };
    };
    const out = await runSuites(await opts({ connector: broken, retries: 0, models: ['mock/a'], repeats: 1 }));
    expect(out.records.length).toBeGreaterThan(0);
    expect(out.records.every((r) => r.outcome === 'error')).toBe(true);
    expect(out.records[0]!.failReason).toMatch(/listTools failed: boom/);
  });
});
