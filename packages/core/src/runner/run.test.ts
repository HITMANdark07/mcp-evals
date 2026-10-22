import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError, CostUnknownError, InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import { FixtureManager } from '../fixtures/manager.js';
import { createInMemoryConnector } from '../mcp/connection.js';
import { MockProvider, parseMockScript, type MockScript } from '../providers/mock.js';
import { parseSuite } from '../suite/load.js';
import type { ChatRequest, Connector, ModelProvider } from '../types.js';
import { runKey } from '../util.js';
import { previewPlan, runSuites, type RunSuitesOptions } from './run.js';

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
    // F5: the trace persists why the run ended.
    expect(failed.trace).toMatchObject({
      outcome: 'fail', end: 'final_answer', failReason: failed.failReason, graders: failed.graders,
      attempts: 1, costUsd: failed.costUsd, steps: failed.steps, contextTokens: failed.contextTokens, latencyMs: failed.latencyMs,
    });
    const passed = out.records.find((r) => r.outcome === 'pass')!;
    expect(passed.trace).not.toHaveProperty('failReason');
    expect(passed.trace).toMatchObject({ outcome: 'pass', end: 'final_answer' });
    expect(out.partial).toBe(false);
    expect(out.planned).toEqual([
      { suite: 'demo', server: 'fake', model: 'mock/a', runs: 4 },
      { suite: 'demo', server: 'fake', model: 'mock/b', runs: 4 },
    ]);
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
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('records error (not fail) after retries are exhausted or for non-retryable errors', async () => {
    const down: ModelProvider = { name: 'down', chat: () => Promise.reject(new ProviderError('500', true, 500)) };
    const sleep = vi.fn(async () => {});
    const out = await runSuites(await opts({ provider: down, sleep, retries: 2, models: ['mock/a'], repeats: 1 }));
    expect(out.records.every((r) => r.outcome === 'error')).toBe(true);
    expect(out.records[0]!.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([2000, 10000, 2000, 10000]);

    const fatal: ModelProvider = { name: 'fatal', chat: () => Promise.reject(new ProviderError('401', false, 401)) };
    const out2 = await runSuites(await opts({ provider: fatal, models: ['mock/a'], repeats: 1 }));
    expect(out2.records[0]).toMatchObject({ outcome: 'error', attempts: 1 });
  });

  it('stops scheduling and marks partial when the budget is spent', async () => {
    const out = await runSuites(await opts({ budgetUsd: 0.0035 }));
    expect(out.partial).toBe(true);
    expect(out.stopReason).toBe('budget');
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

  it('runs server setup without the API key in its environment', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-or-planted-runner-0123456789';
    try {
      const outDir = await mkdtemp(join(tmpdir(), 'runner-env-'));
      const envFile = join(outDir, 'env.txt');
      const suite = parseSuite(SUITE.replace('setup: "echo prepared > setup.txt"', `setup: "env > ${envFile}"`), 'env.yaml');
      await runSuites({ ...(await opts({ models: ['mock/a'], repeats: 1, tasks: ['echo'] })), suites: [suite] });
      const env = await readFile(envFile, 'utf8');
      expect(env).not.toContain('sk-or-planted-runner');
      expect(env).toMatch(/^PATH=/m);
    } finally {
      if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = saved;
    }
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

function capture(script: MockScript = SCRIPT) {
  const requests: ChatRequest[] = [];
  const inner = new MockProvider(script);
  const provider: ModelProvider = { name: 'capture', chat: (req) => (requests.push(req), inner.chat(req)) };
  return { requests, provider };
}

async function localRepo(): Promise<{ git: string; ref: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'runner-repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  await writeFile(join(repo, 'README.md'), 'fixture\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  return { git: repo, ref: git('rev-parse', 'HEAD') };
}

describe('runSuites (M2 wiring)', () => {
  // Review Focus 5
  it('substitutes the real workspace path for {fixture} in prompts and server args alike', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-link-'));
    const realWork = join(root, 'real-work');
    await mkdir(realWork);
    const linkWork = join(root, 'link-work');
    await symlink(realWork, linkWork);
    const repo = await localRepo();
    const suite = parseSuite(
      `
suite: paths
version: 1
fixture: { git: ${JSON.stringify(repo.git)}, ref: ${JSON.stringify(repo.ref)} }
servers:
  fake: { command: unused, args: ["{fixture}"] }
models: [mock/a]
defaults: { repeats: 1 }
tasks:
  - id: where
    prompt: "ECHO in {fixture}"
`,
      'paths.yaml',
    );
    const seen: Array<Record<string, string>> = [];
    const spy: Connector = async (server, ctx) => {
      seen.push(ctx.vars);
      return memory(server, ctx);
    };
    const { requests, provider } = capture();
    const out = await runSuites({
      ...(await opts()),
      suites: [suite],
      provider,
      connector: spy,
      fixtures: new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: linkWork }),
    });
    expect(out.records).toHaveLength(1);
    const fixtureDir = seen[0]!.fixture!;
    expect(fixtureDir.startsWith(`${await realpath(realWork)}${sep}`)).toBe(true);
    expect(fixtureDir).not.toContain('link-work');
    expect(requests[0]!.messages[1]).toEqual({ role: 'user', content: `ECHO in ${fixtureDir}` });
  });

  it('filters tasks and rejects unknown or empty task filters', async () => {
    const out = await runSuites(await opts({ tasks: ['write'], repeats: 1 }));
    expect(out.records.map((r) => r.task)).toEqual(['write', 'write']);
    await expect(runSuites(await opts({ tasks: ['nope'] }))).rejects.toThrow(/Unknown task\(s\): nope/);
    await expect(runSuites(await opts({ tasks: [] }))).rejects.toThrow(/the tasks filter is empty/);
  });

  it('skips cached runKeys, keeps them in the plan, and awaits onRecord in order', async () => {
    const first = await runSuites(await opts({ repeats: 1 }));
    const keep = new Set(first.records.slice(0, 2).map((r) => r.runKey));
    const order: string[] = [];
    const out = await runSuites(
      await opts({
        repeats: 1,
        skip: keep,
        onRecord: async (r) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(r.runKey);
        },
      }),
    );
    expect(out.records).toHaveLength(2);
    expect(out.records.some((r) => keep.has(r.runKey))).toBe(false);
    expect(order).toEqual(out.records.map((r) => r.runKey));
    expect(out.planned.reduce((s, c) => s + c.runs, 0)).toBe(4);
  });

  it('returns no records, without throwing, when every planned run is cached', async () => {
    const first = await runSuites(await opts({ repeats: 1 }));
    const out = await runSuites(await opts({ repeats: 1, skip: new Set(first.records.map((r) => r.runKey)) }));
    expect(out).toMatchObject({ records: [], partial: false, stopReason: null, totalCostUsd: 0 });
  });

  it('previews planned and remaining runs per cell', () => {
    const suites = [parseSuite(SUITE, 'demo.yaml')];
    expect(previewPlan({ suites, repeats: 1 }).planned).toEqual([
      { suite: 'demo', server: 'fake', model: 'mock/a', runs: 2 },
      { suite: 'demo', server: 'fake', model: 'mock/b', runs: 2 },
    ]);
    const skip = new Set([runKey({ suite: 'demo', server: 'fake', model: 'mock/a', task: 'echo', repeat: 0 })]);
    expect(previewPlan({ suites, repeats: 1, skip }).remaining).toEqual([
      { suite: 'demo', server: 'fake', model: 'mock/b', runs: 2 },
      { suite: 'demo', server: 'fake', model: 'mock/a', runs: 1 },
    ]);
    expect(() => previewPlan({ suites, models: ['mock/typo'] })).toThrow(ConfigError);
  });

  it('stops the whole run on OutOfCreditsError: no record for that run, nothing scheduled after it', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const broke: ModelProvider = {
      name: 'broke',
      chat: (req) => (++calls === 3 ? Promise.reject(new OutOfCreditsError('OpenRouter 402')) : inner.chat(req)),
    };
    const out = await runSuites(await opts({ provider: broke }));
    expect(out).toMatchObject({ partial: true, stopReason: 'out_of_credits' });
    expect(calls).toBe(3);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ model: 'mock/a', task: 'echo', outcome: 'pass' });
    expect(out.totalCostUsd).toBeCloseTo(0.002, 9);
  });

  it('grades llm_judge with the suite judge through the same provider and adds its cost', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [{ id: mock/a, provider: acme }]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 1 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders:
      - { type: answer_contains_all, values: [hello] }
      - { type: llm_judge, rubric: "Says hello." }
`,
      'judged.yaml',
    );
    const script = parseMockScript({
      entries: [
        { match: 'ECHO', model: 'mock/a', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
        { match: 'Says hello.', model: 'mock/judge', steps: [{ content: '{"pass": true, "reason": "it says hello"}', usage: { costUsd: 0.0005 } }] },
      ],
    });
    const { requests, provider } = capture(script);
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    const r = out.records[0]!;
    expect(r.outcome).toBe('pass');
    expect(r.graders.find((g) => g.type === 'llm_judge')).toMatchObject({ pass: true, costUsd: 0.0005 });
    expect(r.costUsd).toBeCloseTo(0.0025, 9);
    expect(requests.map((q) => [q.model, q.providerPin])).toEqual([
      ['mock/a', 'acme'],
      ['mock/a', 'acme'],
      ['mock/judge', 'acme'],
    ]);
  });

  it('stops the whole run when the judge reports out of credits', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 2 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders: [{ type: llm_judge, rubric: "Says hello." }]
`,
      'judged.yaml',
    );
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'judge-broke',
      chat: (req) => (req.model === 'mock/judge' ? Promise.reject(new OutOfCreditsError('402')) : inner.chat(req)),
    };
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    expect(out).toMatchObject({ records: [], partial: true, stopReason: 'out_of_credits' });
    expect(out.totalCostUsd).toBeCloseTo(0.002, 9);
  });

  it('counts the agent run\'s spend when the judge fails with an infra error, and the judge cost toward the budget', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 1 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders: [{ type: llm_judge, rubric: "Says hello." }]
`,
      'judged.yaml',
    );
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'judge-down',
      chat: (req) => (req.model === 'mock/judge' ? Promise.reject(new ProviderError('judge bad request', false)) : inner.chat(req)),
    };
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    expect(out.records[0]).toMatchObject({ outcome: 'error' });
    expect(out.records[0]!.costUsd).toBeCloseTo(0.002, 9);
    expect(out.totalCostUsd).toBeCloseTo(0.002, 9);
  });

  it('applies defaults.tool_timeout_s: a slow tool is a model fail (tool_timeout), not an error', async () => {
    const suite = parseSuite(
      `
suite: slow
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
defaults: { repeats: 1, tool_timeout_s: 0.05, timeout_s: 10 }
tasks:
  - id: slow
    prompt: "SLOW task"
`,
      'slow.yaml',
    );
    const script = parseMockScript({ entries: [{ match: 'SLOW', steps: [{ toolCalls: [{ name: 'slow', arguments: { ms: 400 } }] }, { content: 'x' }] }] });
    const out = await runSuites({ ...(await opts()), suites: [suite], provider: new MockProvider(script) });
    expect(out.records[0]).toMatchObject({ outcome: 'fail', end: 'tool_timeout', attempts: 1 });
  });

  it('records the MCP server version on every record', async () => {
    const out = await runSuites(await opts({ models: ['mock/a'], repeats: 1 }));
    expect(out.records.every((r) => r.serverVersion === '1.0.0')).toBe(true);
  });

  it('rejects an invalid budget before running anything', async () => {
    await expect(runSuites(await opts({ budgetUsd: Number.NaN }))).rejects.toThrow(/budgetUsd/);
    await expect(runSuites(await opts({ budgetUsd: -1 }))).rejects.toThrow(/budgetUsd/);
  });

  it('keeps the shorter backoff for server and setup retries', async () => {
    let starts = 0;
    const flaky: Connector = async (server, ctx) => {
      if (starts++ < 2) throw new InfraError('server', 'failed to start', true);
      return memory(server, ctx);
    };
    const sleep = vi.fn(async () => {});
    const out = await runSuites(await opts({ connector: flaky, sleep, models: ['mock/a'], repeats: 1, tasks: ['echo'] }));
    expect(out.records[0]).toMatchObject({ outcome: 'pass', attempts: 3 });
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([500, 1000]);
  });

  it('stops the whole run (resumable, no record) when the agent call cost cannot be determined', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'cost-unknown',
      chat: (req) => (++calls === 3 ? Promise.reject(new CostUnknownError('usage.cost missing and no catalog price for mock/b')) : inner.chat(req)),
    };
    const out = await runSuites(await opts({ provider }));
    expect(out).toMatchObject({ partial: true, stopReason: 'cost_unknown', stopDetail: 'usage.cost missing and no catalog price for mock/b' });
    expect(calls).toBe(3);
    expect(out.records).toHaveLength(1);
    expect(out.totalCostUsd).toBeCloseTo(0.002, 9);
  });

  it('stops the whole run when the judge call cost cannot be determined, counting the agent spend', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 2 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders: [{ type: llm_judge, rubric: "Says hello." }]
`,
      'judged.yaml',
    );
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'judge-unknown',
      chat: (req) => (req.model === 'mock/judge' ? Promise.reject(new CostUnknownError('usage.cost missing and token counts missing for mock/judge', 0.0003)) : inner.chat(req)),
    };
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    expect(out).toMatchObject({ records: [], partial: true, stopReason: 'cost_unknown', stopDetail: 'usage.cost missing and token counts missing for mock/judge' });
    expect(out.totalCostUsd).toBeCloseTo(0.0023, 9);
  });

  it('accumulates the spend of failed attempts (aborted or error-body calls) across retries', async () => {
    let calls = 0;
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'timeout-once',
      chat: (req) => (calls++ === 0 ? Promise.reject(new ProviderError('OpenRouter request timed out after 120000ms', true, undefined, 0.005)) : inner.chat(req)),
    };
    const out = await runSuites(await opts({ provider, models: ['mock/a'], repeats: 1, tasks: ['echo'] }));
    expect(out.records[0]).toMatchObject({ outcome: 'pass', attempts: 2 });
    expect(out.records[0]!.costUsd).toBeCloseTo(0.007, 12);
    expect(out.totalCostUsd).toBeCloseTo(0.007, 12);
  });

  it('counts the spend of failed judge attempts on the error record', async () => {
    const suite = parseSuite(
      `
suite: judged
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
judge: { id: mock/judge, provider: acme }
defaults: { repeats: 1 }
tasks:
  - id: echo
    prompt: "ECHO judged"
    graders: [{ type: llm_judge, rubric: "Says hello." }]
`,
      'judged.yaml',
    );
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'judge-err-body',
      chat: (req) => (req.model === 'mock/judge' ? Promise.reject(new ProviderError('OpenRouter 400: bad', false, 400, 0.003)) : inner.chat(req)),
    };
    const out = await runSuites({ ...(await opts()), suites: [suite], provider });
    expect(out.records[0]).toMatchObject({ outcome: 'error' });
    expect(out.records[0]!.costUsd).toBeCloseTo(0.005, 12);
    expect(out.totalCostUsd).toBeCloseTo(0.005, 12);
  });

  it('stops the run when one model produces 3 consecutive identical provider errors', async () => {
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'model-a-broken',
      chat: (req) => (req.model === 'mock/a' ? Promise.reject(new ProviderError('OpenRouter 400: tools not supported', false, 400)) : inner.chat(req)),
    };
    const out = await runSuites(await opts({ provider, repeats: 3 }));
    expect(out).toMatchObject({ partial: true, stopReason: 'repeated_provider_error' });
    expect(out.stopDetail).toBe('mock/a: provider: OpenRouter 400: tools not supported');
    // a-echo, b-echo, a-write, b-write, a-echo (#1): the third identical error for mock/a ends the run.
    expect(out.records.map((r) => `${r.model}/${r.outcome}`)).toEqual(['mock/a/error', 'mock/b/fail', 'mock/a/error', 'mock/b/pass', 'mock/a/error']);
  });

  it('does not stop for provider errors that differ, or that another outcome interrupts', async () => {
    let n = 0;
    const inner = new MockProvider(SCRIPT);
    const provider: ModelProvider = {
      name: 'varied',
      chat: (req) => (req.model === 'mock/a' ? Promise.reject(new ProviderError(`OpenRouter 400: error ${n++}`, false, 400)) : inner.chat(req)),
    };
    const out = await runSuites(await opts({ provider, repeats: 3 }));
    expect(out).toMatchObject({ partial: false, stopReason: null });
    expect(out.records).toHaveLength(12);
  });
});

describe('task vars', () => {
  it('passes task vars, fixture and suite_dir to the server and the prompt', async () => {
    const seen: Array<Record<string, string>> = [];
    const connector = createInMemoryConnector((ctx) => {
      seen.push(ctx.vars);
      return buildFakeServer(ctx.cwd);
    });
    const suite = parseSuite(
      `
suite: vars
version: 1
servers:
  fake: { command: unused }
models: [mock/a]
defaults: { repeats: 1, max_steps: 3, timeout_s: 10 }
tasks:
  - id: t
    prompt: "VARS task={task} seed={seed}"
    vars: { task: damaged_item, seed: "3" }
    graders: [{ type: answer_contains_all, values: [ok] }]
`,
      '/tmp/suites/vars.yaml',
    );
    const script = parseMockScript({ entries: [{ match: 'VARS task=damaged_item seed=3', steps: [{ content: 'ok' }] }] });
    const out = await runSuites(await opts({ suites: [suite], provider: new MockProvider(script), connector }));
    expect(out.records[0]!.outcome).toBe('pass');
    expect(seen[0]).toMatchObject({ task: 'damaged_item', seed: '3', suite_dir: '/tmp/suites' });
    expect(seen[0]!.fixture).toBeTruthy();
  });
});

describe('hidden tools and env_reward', () => {
  const ENV_SUITE = `
suite: env
version: 1
servers:
  env: { command: unused, hidden_tools: [__score] }
models: [mock/a]
defaults: { repeats: 1, max_steps: 4, timeout_s: 10 }
tasks:
  - id: act
    prompt: "ENV act once"
    graders: [{ type: env_reward, tool: __score }]
  - id: peek
    prompt: "ENV peek"
    graders: [{ type: env_reward, tool: __score }]
`;
  function envServer() {
    let actions = 0;
    const server = new McpServer({ name: 'env', version: '1' });
    server.registerTool('act', { description: 'Do the task' }, async () => {
      actions++;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    server.registerTool('__score', { description: 'harness only' }, async () => ({ content: [{ type: 'text', text: JSON.stringify({ reward: actions >= 1 ? 1 : 0 }) }] }));
    return server;
  }
  const script = parseMockScript({
    entries: [
      { match: 'ENV act once', steps: [{ toolCalls: [{ name: 'act', arguments: {} }] }, { content: 'finished' }] },
      { match: 'ENV peek', steps: [{ toolCalls: [{ name: '__score', arguments: {} }] }, { content: 'peeked' }] },
    ],
  });

  it('scores through the hidden tool on the same connection and never offers it to the model', async () => {
    const offered: string[][] = [];
    const inner = new MockProvider(script);
    const provider = { name: 'mock', chat: async (req: ChatRequest) => { offered.push(req.tools.map((t) => t.name)); return inner.chat(req); } };
    const out = await runSuites(await opts({ suites: [parseSuite(ENV_SUITE, 'env.yaml')], provider, connector: createInMemoryConnector(() => envServer()) }));
    const act = out.records.find((r) => r.task === 'act')!;
    expect(act.outcome).toBe('pass');
    expect(act.graders[0]).toMatchObject({ type: 'env_reward', pass: true, value: 1 });
    expect(offered.every((names) => !names.includes('__score'))).toBe(true);
    const peek = out.records.find((r) => r.task === 'peek')!;
    expect(peek).toMatchObject({ outcome: 'fail', end: 'invalid_tool_call' });
  });

  it('errors the run when the env_reward tool does not exist', async () => {
    const suite = parseSuite(ENV_SUITE.replace(/tool: __score/g, 'tool: __missing'), 'env.yaml');
    const out = await runSuites(await opts({ suites: [suite], provider: new MockProvider(script), connector: createInMemoryConnector(() => envServer()) }));
    expect(out.records[0]).toMatchObject({ outcome: 'error' });
    expect(out.records[0]!.failReason).toMatch(/unknown tool "__missing"/);
  });
});
