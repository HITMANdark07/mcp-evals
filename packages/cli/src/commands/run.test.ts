import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultsSchema } from '@mcp-evals/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completion,
  startFakeOpenRouter,
  toolCall,
  type FakeOpenRouter,
  type FakeOpenRouterOptions,
  type FakeReply,
} from '../../../core/test/fixtures/fake-openrouter.js';
import { main, type ProgramDeps } from '../program.js';
import { runCommand, type RunCommandOptions } from './run.js';

const FAKE = fileURLToPath(new URL('../../../core/test/fixtures/fake-server.mjs', import.meta.url));

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'cli-run-'));
  const suite = join(dir, 'suite.yaml');
  await writeFile(
    suite,
    [
      'suite: e2e',
      'version: 1',
      'servers:',
      `  fake: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}] }`,
      'models: [mock/a]',
      'defaults: { repeats: 2, max_steps: 4, timeout_s: 20 }',
      'tasks:',
      '  - id: echo',
      '    prompt: "ECHO please"',
      '    graders: [{ type: tool_called, tool: echo }, { type: answer_contains_all, values: [hello] }]',
      '  - id: crash',
      '    prompt: "CRASH please"',
      '    graders: [{ type: tool_called, tool: crash }]',
    ].join('\n'),
  );
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      entries: [
        { match: 'ECHO', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
        { match: 'CRASH', steps: [{ toolCalls: [{ name: 'crash' }] }, { content: 'unreachable' }] },
      ],
    }),
  );
  return { dir, suite, script };
}

const base = (dir: string, lines: string[]) => ({
  out: join(dir, 'r.json'), cacheDir: join(dir, 'c'), runsDir: join(dir, 'runs'), retries: 0, env: {}, log: (l: string) => lines.push(l),
});

describe('runCommand (end-to-end over stdio, mock model)', () => {
  it('runs, writes valid results and traces, and prints a table', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const { exitCode, results, runId } = await runCommand({
      ...base(dir, lines), suites: [suite], provider: 'mock', mockScript: script,
      out: join(dir, 'out', 'results.json'), traces: join(dir, 'traces.jsonl'),
    });
    expect(exitCode).toBe(0);
    const written = ResultsSchema.parse(JSON.parse(await readFile(join(dir, 'out', 'results.json'), 'utf8')));
    expect(written).toEqual(results);
    const cell = written.suites[0]!.cells[0]!;
    expect(cell).toMatchObject({ runs: 4, plannedRuns: 4, complete: true });
    expect(cell.tasks).toEqual([
      expect.objectContaining({ id: 'echo', passes: 2, fails: 0, errors: 0 }),
      // a crashing server is an error, never a model fail
      expect.objectContaining({ id: 'crash', passes: 0, fails: 0, errors: 2 }),
    ]);
    expect(cell.errorRate).toBe(0.5);
    expect(written.suites[0]!.servers.fake!.version).toBe('1.0.0');
    expect(written.suites[0]!.servers.fake!.args).toEqual([FAKE]);
    expect(written).toMatchObject({ harnessVersion: '0.2.0', harnessCommit: expect.stringMatching(/^[0-9a-f]{7,}$/) });
    expect(cell.successRateWithErrors).toBe(0.5);
    const traces = (await readFile(join(dir, 'traces.jsonl'), 'utf8')).trim().split('\n');
    expect(traces).toHaveLength(4);
    expect(JSON.parse(traces[0]!)).toMatchObject({ outcome: 'pass', end: 'final_answer', attempts: 1 });
    const crashTrace = traces.map((l) => JSON.parse(l)).find((t) => t.task === 'crash');
    expect(crashTrace).toMatchObject({ outcome: 'error', end: 'infra_error', failReason: expect.stringMatching(/server/) });
    expect(lines.some((l) => l.startsWith('SUITE'))).toBe(true);
    expect(lines[0]).toBe(`run ${runId}: 4 run(s) to execute`);
    expect(existsSync(join(dir, 'runs', `${runId}.jsonl`))).toBe(true);
  });

  it('exits 2 with a clear message for invalid suites and bad flags', async () => {
    const { dir, suite, script } = await workspace();
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, 'suite: x\nversion: 1\n');
    const lines: string[] = [];
    const b = base(dir, lines);
    expect((await runCommand({ ...b, suites: [bad], provider: 'mock', mockScript: script })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'openrouter' })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'mock' })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'mock', mockScript: script, models: ['mock/typo'] })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'gpt' })).exitCode).toBe(2);
    expect((await runCommand({ ...b, suites: [suite], provider: 'mock', mockScript: script, retryErrors: true })).exitCode).toBe(2);
    expect(lines.at(-1)).toBe('error: --retry-errors only applies with --resume <runId>');
    expect(lines.filter((l) => l.startsWith('error: '))).toHaveLength(6);
    expect(lines).toHaveLength(6);
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('exits 2 when filters leave nothing to run', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    expect((await runCommand({ ...base(dir, lines), suites: [suite], provider: 'mock', mockScript: script, models: [] })).exitCode).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^error: no runs to execute/)]);
  });

  it('exits 2, before any run, when a later suite has a bad fixture', async () => {
    const { dir, suite, script } = await workspace();
    const second = join(dir, 'second.yaml');
    await writeFile(
      second,
      (await readFile(suite, 'utf8')).replace('suite: e2e', 'suite: second\nfixture: { git: "/definitely/not/a/repo.git", ref: abc1234 }'),
    );
    const lines: string[] = [];
    const res = await runCommand({ ...base(dir, lines), suites: [suite, second], provider: 'mock', mockScript: script, traces: join(dir, 't.jsonl') });
    expect(res.exitCode).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^error: failed to fetch fixture \/definitely\/not\/a\/repo\.git@abc1234/)]);
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
    expect(existsSync(join(dir, 't.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('exits 2 naming the file for missing or invalid suite and mock-script files', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const b = base(dir, lines);
    const missingSuite = join(dir, 'missing.yaml');
    const missingScript = join(dir, 'missing.json');
    const badJson = join(dir, 'bad.json');
    await writeFile(badJson, '{not json');
    const badShape = join(dir, 'shape.json');
    await writeFile(badShape, JSON.stringify({ entries: [{ match: 'X', steps: [] }] }));
    const cases: [RunCommandOptions, string][] = [
      [{ ...b, suites: [missingSuite], provider: 'mock', mockScript: script }, missingSuite],
      [{ ...b, suites: [suite], provider: 'mock', mockScript: missingScript }, missingScript],
      [{ ...b, suites: [suite], provider: 'mock', mockScript: badJson }, badJson],
      [{ ...b, suites: [suite], provider: 'mock', mockScript: badShape }, badShape],
    ];
    for (const [opts, path] of cases) {
      lines.length = 0;
      expect((await runCommand(opts)).exitCode).toBe(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: /);
      expect(lines[0]).toContain(path);
      expect(lines[0]).not.toMatch(/\n\s+at /);
    }
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
  });
});

// ---- OpenRouter path, against the local fake OpenRouter server -------------------------

const LIVE_SUITE = [
  'suite: live',
  'version: 1',
  'servers:',
  `  fake: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}] }`,
  'models: [{ id: acme/model-a, provider: acme }]',
  'judge: { id: acme/judge, provider: acme }',
  'defaults: { repeats: 2, max_steps: 4, timeout_s: 20 }',
  'tasks:',
  '  - id: echo',
  '    prompt: "ECHO please"',
  '    graders:',
  '      - { type: answer_contains_all, values: [hello] }',
  '      - { type: llm_judge, rubric: "Says hello." }',
].join('\n');

/** Agent: call echo, then answer "hello" ($0.001 per call). Judge: pass ($0.0001). So $0.0021 per run. */
function script(body: any): FakeReply {
  if (body.model === 'acme/judge') {
    return { json: completion({ content: '{"pass": true, "reason": "ok"}' }, { prompt_tokens: 50, completion_tokens: 5, cost: 0.0001 }) };
  }
  const last = body.messages.at(-1);
  return last.role === 'tool'
    ? { json: completion({ content: 'hello' }, { prompt_tokens: 200, completion_tokens: 5, cost: 0.001 }) }
    : { json: completion({ tool_calls: [toolCall('c1', 'echo', { text: 'hello' })] }, { prompt_tokens: 100, completion_tokens: 5, cost: 0.001 }) };
}

let fake: FakeOpenRouter | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function liveSetup(o: FakeOpenRouterOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-live-'));
  const suite = join(dir, 'live.yaml');
  await writeFile(suite, LIVE_SUITE);
  const f = await startFakeOpenRouter({ respond: script, ...o });
  fake = f;
  const lines: string[] = [];
  const opts: RunCommandOptions = {
    suites: [suite], provider: 'openrouter', env: { OPENROUTER_API_KEY: 'sk-test-key' }, openRouterBaseUrl: f.baseUrl,
    out: join(dir, 'results.json'), traces: join(dir, 'traces.jsonl'), cacheDir: join(dir, 'cache'), runsDir: join(dir, 'runs'),
    retries: 0, log: (l) => lines.push(l),
  };
  return { dir, suite, lines, opts, fake: f };
}

describe('runCommand --provider openrouter (fake OpenRouter, stdio fake server)', () => {
  it('pre-flights, runs, judges, and writes v2 results with pins, versions and costs', async () => {
    const { opts, lines, fake } = await liveSetup();
    const { exitCode, results, runId } = await runCommand(opts);
    expect(exitCode).toBe(0);
    const s = results!.suites[0]!;
    expect(s.models).toEqual([{ id: 'acme/model-a', provider: 'acme' }]);
    expect(s.judge).toEqual({ id: 'acme/judge', provider: 'acme' });
    expect(s.servers.fake!.version).toBe('1.0.0');
    expect(s.cells[0]).toMatchObject({ runs: 2, plannedRuns: 2, complete: true, successRate: 1 });
    expect(results!.partial).toBe(false);
    expect(results!.totalCostUsd).toBeCloseTo(2 * 0.0021, 9);
    const chats = fake.chatRequests();
    expect(chats).toHaveLength(6);
    expect(chats.every((r) => r.body.provider.order[0] === 'acme' && r.body.provider.allow_fallbacks === false)).toBe(true);
    expect(lines).toContain('  live/fake: 9 tools, version 1.0.0');
    expect(lines.some((l) => /^plan: 2 run\(s\), 2 to execute; estimated cost \$0\.0540$/.test(l))).toBe(true);
    expect(existsSync(join(opts.runsDir!, `${runId}.jsonl`))).toBe(true);
    for (const path of [opts.out, opts.traces!, join(opts.runsDir!, `${runId}.jsonl`), join(opts.runsDir!, `${runId}.manifest.json`)]) {
      expect(await readFile(path, 'utf8')).not.toContain('sk-test-key');
    }
    expect(lines.join('\n')).not.toContain('sk-test-key');
  });

  it('exits 2 before any request when OPENROUTER_API_KEY is missing', async () => {
    const { opts, lines, fake } = await liveSetup();
    expect((await runCommand({ ...opts, env: {} })).exitCode).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^error: OPENROUTER_API_KEY is not set\. Copy \.env\.example to \.env/)]);
    expect(fake.requests).toHaveLength(0);
    expect(existsSync(opts.out)).toBe(false);
    expect(existsSync(opts.runsDir!)).toBe(false);
  });

  it('exits 2 when a model is missing from the catalog', async () => {
    const { opts, lines, fake } = await liveSetup({ models: [{ id: 'acme/judge', supported_parameters: [], pricing: { prompt: '0', completion: '0' } }] });
    expect((await runCommand(opts)).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/model "acme\/model-a" is not in the OpenRouter catalog/);
    expect(fake.chatRequests()).toHaveLength(0);
  });

  it('exits 2 when a model has no tool support', async () => {
    const { opts, lines } = await liveSetup({
      models: [
        { id: 'acme/model-a', supported_parameters: ['temperature'], pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'acme/judge', supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
      ],
    });
    expect((await runCommand(opts)).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/does not support tool calling/);
  });

  it('exits 2 when a model has no provider pin', async () => {
    const { opts, lines, suite } = await liveSetup();
    await writeFile(suite, LIVE_SUITE.replace('models: [{ id: acme/model-a, provider: acme }]', 'models: [acme/model-a]'));
    expect((await runCommand(opts)).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/model "acme\/model-a" has no provider pin/);
  });

  it('aborts when the estimate exceeds --budget-usd, unless --yes', async () => {
    const { opts, lines, fake } = await liveSetup();
    // catalog: 25k × $0.000001 + 1k × $0.000002 = $0.027 per run, 2 runs → $0.054
    expect((await runCommand({ ...opts, budgetUsd: 0.05 })).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/^error: estimated cost \$0\.0540 exceeds --budget-usd \$0\.0500/);
    expect(fake.chatRequests()).toHaveLength(0);
    expect((await runCommand({ ...opts, budgetUsd: 0.05, yes: true })).exitCode).toBe(0);
  });

  it('estimates from measured cost per run with --estimate-from', async () => {
    const { opts, lines } = await liveSetup();
    expect((await runCommand(opts)).exitCode).toBe(0);
    lines.length = 0;
    const second = await runCommand({ ...opts, out: join(dirname(opts.out), 'r2.json'), estimateFrom: opts.out, budgetUsd: 0.01 });
    expect(second.exitCode).toBe(0);
    expect(lines).toContain('  acme/model-a: 2 run(s) × $0.0021 (measured)');
  });

  it('stops on 402 with partial results, then --resume finishes without re-running finished runs', async () => {
    let n = 0;
    const credits: FakeReply = { status: 402, json: { error: { code: 402, message: 'Insufficient credits' } } };
    const { opts, lines, fake } = await liveSetup({ respond: (body) => (++n === 4 ? credits : script(body)) });
    const first = await runCommand(opts);
    expect(first.exitCode).toBe(0);
    expect(first.results!.partial).toBe(true);
    expect(first.results!.suites[0]!.cells[0]).toMatchObject({ runs: 1, plannedRuns: 2, complete: false });
    expect(lines.some((l) => l.startsWith('STOPPED: OpenRouter reports the key is out of credits'))).toBe(true);
    expect(lines.some((l) => l.includes(`--resume ${first.runId}`))).toBe(true);

    const before = fake.chatRequests().length;
    const second = await runCommand({ ...opts, resume: first.runId! });
    expect(second.exitCode).toBe(0);
    expect(second.runId).toBe(first.runId);
    expect(fake.chatRequests().length - before).toBe(3);
    expect(second.results).toMatchObject({ partial: false, runId: first.runId });
    expect(second.results!.suites[0]!.cells[0]).toMatchObject({ runs: 2, plannedRuns: 2, complete: true });
    expect(second.results!.totalCostUsd).toBeCloseTo(2 * 0.0021, 9);
    expect((await readFile(opts.traces!, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('refuses to resume when the suite changed, or when the run id is unknown', async () => {
    const { opts, lines, suite } = await liveSetup();
    const first = await runCommand(opts);
    await writeFile(suite, LIVE_SUITE.replace('ECHO please', 'ECHO please now'));
    expect((await runCommand({ ...opts, resume: first.runId! })).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/cannot resume run .*: the configuration changed/);
    expect((await runCommand({ ...opts, resume: 'no-such-run' })).exitCode).toBe(2);
    expect(lines.at(-1)).toMatch(/no cached run "no-such-run"/);
  });
});

// ---- Stops, resume command, --retry-errors ----------------------------------------------

/** Splits a printed command line exactly like the shell would. */
function shellSplit(cmd: string): string[] {
  return execFileSync('sh', ['-c', `printf '%s\\0' ${cmd}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }).split('\0').slice(0, -1);
}

function cliDeps(lines: string[]): ProgramDeps {
  const unused = async () => ({ exitCode: 99 });
  return {
    run: (o) => runCommand({ ...o, env: {}, log: (l) => lines.push(l) }),
    compare: unused,
    report: unused,
    publish: unused,
    writeOut: (s) => lines.push(s),
    writeErr: (s) => lines.push(s),
  };
}

describe('stops and resuming', () => {
  it('prints a STOPPED line and a runnable resume command that main accepts with a fresh budget', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const flags = [
      '--provider', 'mock', '--mock-script', script, '--tasks', 'echo,crash', '--repeats', '2',
      '--out', join(dir, 'res ults.json'), '--traces', join(dir, 'traces.jsonl'), '--runs-dir', join(dir, 'runs'), '--cache-dir', join(dir, 'cache'),
    ];
    expect(await main(['run', suite, ...flags, '--budget-usd', '0.002'], cliDeps(lines))).toBe(0);
    expect(lines).toContain('STOPPED: budget cap reached (--budget-usd $0.0020) — run is resumable');
    const commentAt = lines.findIndex((l) => l.startsWith('# Resume the remaining runs'));
    expect(commentAt).toBeGreaterThan(-1);
    expect(lines[commentAt]).toContain('<amount>');
    const command = lines[commentAt + 1]!;
    expect(command).toMatch(/ --budget-usd <amount>$/);
    const argv = shellSplit(command.replace('<amount>', '1'));
    expect(argv.slice(0, 2)).toEqual([process.argv[0], process.argv[1]]);
    expect(argv).toEqual(expect.arrayContaining(['--resume', '--provider', 'mock', '--tasks', 'echo,crash', '--repeats', '2', join(dir, 'res ults.json')]));

    lines.length = 0;
    expect(await main(argv.slice(2), cliDeps(lines))).toBe(0);
    expect(lines.join('\n')).not.toMatch(/configuration changed|^error:/m);
    expect(lines[0]).toMatch(/^run \S+: 3 run\(s\) to execute, 1 reused from the run cache$/);
    const results = JSON.parse(await readFile(join(dir, 'res ults.json'), 'utf8'));
    expect(results).toMatchObject({ partial: false });
    expect(lines.some((l) => l.startsWith('STOPPED'))).toBe(false);
  });

  it('--retry-errors re-runs error records, keeps one record per run, and keeps their spend in the total', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const opts: RunCommandOptions = { ...base(dir, lines), suites: [suite], provider: 'mock', mockScript: script, traces: join(dir, 't.jsonl') };
    const first = await runCommand(opts);
    // echo: 2 calls × $0.001; crash: 1 call before the server dies → 2 × 0.002 + 2 × 0.001
    expect(first.results!.totalCostUsd).toBeCloseTo(0.006, 9);
    expect(first.results!.suites[0]!.cells[0]!.errorRate).toBe(0.5);

    lines.length = 0;
    const plain = await runCommand({ ...opts, resume: first.runId! });
    expect(lines[0]).toBe(`run ${first.runId}: 0 run(s) to execute, 4 reused from the run cache`);
    expect(plain.results!.totalCostUsd).toBeCloseTo(0.006, 9);

    lines.length = 0;
    const retried = await runCommand({ ...opts, resume: first.runId!, retryErrors: true });
    expect(lines[0]).toBe(`run ${first.runId}: 2 run(s) to execute, 2 reused from the run cache`);
    expect(retried.results!.suites[0]!.cells[0]).toMatchObject({ runs: 4, plannedRuns: 4, complete: true });
    expect(retried.results!.totalCostUsd).toBeCloseTo(0.008, 9);
    expect((await readFile(opts.traces!, 'utf8')).trim().split('\n')).toHaveLength(4);
    const manifest = JSON.parse(await readFile(join(dir, 'runs', `${first.runId}.manifest.json`), 'utf8'));
    expect(manifest.unrecordedSpendUsd).toBeCloseTo(0.002, 9);

    // A later resume reads the last record per run and still reports every dollar spent.
    const again = await runCommand({ ...opts, resume: first.runId! });
    expect(again.results!.totalCostUsd).toBeCloseTo(0.008, 9);
    expect(again.results!.suites[0]!.cells[0]!.runs).toBe(4);
  });
});

describe('STOPPED lines (fake OpenRouter)', () => {
  it('cost could not be determined', async () => {
    const noUsage = completion({ content: 'hello' }) as Record<string, unknown>;
    delete noUsage.usage;
    const { opts, lines } = await liveSetup({ respond: () => ({ json: noUsage }) });
    const res = await runCommand(opts);
    expect(res.exitCode).toBe(0);
    expect(res.results!.partial).toBe(true);
    expect(lines).toContain('STOPPED: cost could not be determined (usage.cost missing and token counts missing for acme/model-a) — run is resumable');
    expect(lines.some((l) => l.includes(`--resume ${res.runId}`))).toBe(true);
  });

  it('repeated identical provider errors', async () => {
    const bad: FakeReply = { status: 400, json: { error: { code: 400, message: 'tool use is not supported' } } };
    const { opts, lines, fake } = await liveSetup({ respond: () => bad });
    const res = await runCommand({ ...opts, repeats: 4 });
    expect(res.results!.partial).toBe(true);
    expect(fake.chatRequests()).toHaveLength(3);
    expect(lines).toContain(
      'STOPPED: 3 consecutive runs of acme/model-a ended in the same provider error (provider: OpenRouter 400: tool use is not supported) — run is resumable',
    );
    expect(lines.some((l) => l.startsWith('# Add --retry-errors'))).toBe(true);
  });
});
