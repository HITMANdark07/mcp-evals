import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError, InfraError, ProviderError } from '../errors.js';
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
    // F1: a budget cut-off is not a run outcome — no record, no error, but its spend is counted.
    expect(out.records.some((r) => r.end === 'budget')).toBe(false);
    expect(out.records.some((r) => r.outcome === 'error' && /budget/.test(r.failReason ?? ''))).toBe(false);
    const recorded = out.records.reduce((s, r) => s + r.costUsd, 0);
    expect(out.totalCostUsd).toBeGreaterThan(recorded);
    expect(out.totalCostUsd).toBeCloseTo(0.004, 9);
  });

  it('interleaves the schedule so a budget cut-off still covers every model', async () => {
    const out = await runSuites(await opts({ budgetUsd: 0.007 }));
    expect(out.partial).toBe(true);
    expect(out.records.length).toBeLessThan(8);
    expect(out.records.some((r) => r.model === 'mock/a')).toBe(true);
    expect(out.records.some((r) => r.model === 'mock/b')).toBe(true);
  });

  it('snapshots the workspace after setup and server start, so fs_state judges only the agent', async () => {
    const suite = parseSuite(
      `
suite: snap
version: 1
servers:
  fake: { command: unused, setup: "echo touched >> config.txt" }
models: [mock/b]
defaults: { repeats: 1 }
tasks:
  - id: idle
    prompt: "IDLE"
    graders: [{ type: fs_state, path: config.txt, unchanged: true }]
`,
      'snap.yaml',
    );
    const out = await runSuites({ ...(await opts()), suites: [suite] });
    expect(out.records.map((r) => r.outcome)).toEqual(['pass']);
  });

  it('prepares every fixture before the first run, and fails before any spend', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const counting: ModelProvider = { name: 'count', chat: (req) => (calls++, inner.chat(req)) };
    const good = parseSuite(SUITE, 'good.yaml');
    const bad = parseSuite(SUITE.replace('suite: demo', 'suite: broken\nfixture: { git: "/definitely/not/a/repo.git", ref: abc1234 }'), 'bad.yaml');
    const err = await runSuites({ ...(await opts()), provider: counting, suites: [good, bad] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'fixture' });
    expect(calls).toBe(0);
  });

  it('does not prepare fixtures of suites with no planned runs', async () => {
    const good = parseSuite(SUITE, 'good.yaml');
    const bad = parseSuite(
      SUITE.replace('suite: demo', 'suite: other\nfixture: { git: "/definitely/not/a/repo.git", ref: abc1234 }').replace('models: [mock/a, mock/b]', 'models: [mock/c]'),
      'other.yaml',
    );
    const out = await runSuites({ ...(await opts()), suites: [good, bad], models: ['mock/a'], repeats: 1 });
    expect(out.records).toHaveLength(2);
  });

  it('rejects filters that leave nothing to run', async () => {
    await expect(runSuites(await opts({ models: [] }))).rejects.toBeInstanceOf(ConfigError);
    await expect(runSuites(await opts({ models: [] }))).rejects.toThrow(/no runs to execute/);
    await expect(runSuites(await opts({ servers: [] }))).rejects.toThrow(/no runs to execute/);
    const scoped = parseSuite(SUITE.replace('prompt: "ECHO task"', 'prompt: "ECHO task"\n    servers: [fake]'), 'scoped.yaml');
    const other = parseSuite(
      `
suite: two
version: 1
servers:
  fake: { command: unused }
  extra: { command: unused }
models: [mock/a]
tasks:
  - id: only-fake
    prompt: "ECHO"
    servers: [fake]
`,
      'two.yaml',
    );
    await expect(runSuites({ ...(await opts()), suites: [scoped, other], servers: ['extra'] })).rejects.toThrow(/no runs to execute/);
  });

  it('records a non-retried error, without calling the model, when a grader names a tool the server lacks', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const counting: ModelProvider = { name: 'count', chat: (req) => (calls++, inner.chat(req)) };
    const suite = parseSuite(
      `
suite: typo
version: 1
servers:
  fake: { command: unused }
  other: { command: unused }
models: [mock/a]
defaults: { repeats: 1 }
tasks:
  - id: typo
    prompt: "ECHO"
    graders:
      - { type: tool_called, tool: ecko }
      - { type: tool_not_called, tool: also_missing }
      - { type: tool_args_match, tool: nope, args: {}, server: other }
`,
      'typo.yaml',
    );
    const out = await runSuites({ ...(await opts()), provider: counting, suites: [suite], servers: ['fake'] });
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ outcome: 'error', attempts: 1, failReason: 'grader references unknown tool "ecko" on server "fake"' });
    expect(calls).toBe(0);
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

  it('records error (no crash) when the connector throws an unexpected error', async () => {
    const boom: Connector = () => Promise.reject(new Error('spawn exploded'));
    const out = await runSuites(await opts({ connector: boom, models: ['mock/a'], repeats: 1 }));
    expect(out.records.every((r) => r.outcome === 'error' && r.attempts === 1)).toBe(true);
    expect(out.records[0]!.failReason).toMatch(/unexpected: spawn exploded/);
  });

  it('records a non-retried error when server setup fails', async () => {
    const o = await opts({ models: ['mock/a'], repeats: 1 });
    const bad = parseSuite(SUITE.replace('setup: "echo prepared > setup.txt"', 'setup: "exit 7"'), 'bad.yaml');
    const out = await runSuites({ ...o, suites: [bad] });
    expect(out.records.every((r) => r.outcome === 'error' && r.attempts === 1)).toBe(true);
  });

  it('still disposes the workspace when conn.close() rejects', async () => {
    const dirs: string[] = [];
    const bad: Connector = async (server, ctx) => {
      dirs.push(ctx.cwd);
      const conn = await memory(server, ctx);
      return {
        ...conn,
        listTools: () => conn.listTools(),
        callTool: (...a: Parameters<typeof conn.callTool>) => conn.callTool(...a),
        stderr: () => conn.stderr(),
        close: async () => {
          await conn.close();
          throw new Error('close failed');
        },
      };
    };
    const out = await runSuites(await opts({ connector: bad, models: ['mock/a'], repeats: 1 }));
    expect(out.records.map((r) => r.outcome)).toEqual(['pass', 'pass']);
    for (const d of dirs) await expect(access(d)).rejects.toThrow();
  });
});
