import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Results } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { publishCommand } from './publish.js';

async function setup(over: Partial<Results> = {}, traceLines = 4) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-'));
  const r = results([cell({ server: 'neatcode', model: 'acme/a' })], over); // the cell has 4 runs
  const resultsPath = join(dir, 'results.json');
  await writeFile(resultsPath, JSON.stringify(r));
  const traces = `${Array.from({ length: traceLines }, (_, i) => JSON.stringify({ runKey: `k${i}`, events: [] })).join('\n')}\n`;
  const tracesPath = join(dir, 'traces.jsonl');
  await writeFile(tracesPath, traces);
  const lines: string[] = [];
  return { dir, r, resultsPath, tracesPath, traces, dataDir: join(dir, 'data'), lines, log: (l: string) => lines.push(l) };
}

describe('publishCommand', () => {
  it('writes data/runs/<runId>/results.json and traces.jsonl.gz, and data/latest.json with --latest', async () => {
    const s = await setup();
    const res = await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, latest: true, log: s.log });
    expect(res.exitCode).toBe(0);
    const runDir = join(s.dataDir, 'runs', 'run-1');
    const published = await readFile(join(runDir, 'results.json'), 'utf8');
    expect(JSON.parse(published)).toEqual(s.r);
    expect(gunzipSync(await readFile(join(runDir, 'traces.jsonl.gz'))).toString('utf8')).toBe(s.traces);
    expect(await readFile(join(s.dataDir, 'latest.json'), 'utf8')).toBe(published);
    expect(s.lines.some((l) => l.includes(join(runDir, 'results.json')))).toBe(true);
  });

  it('leaves data/latest.json alone without --latest', async () => {
    const s = await setup();
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(0);
    expect(existsSync(join(s.dataDir, 'latest.json'))).toBe(false);
  });

  it('refuses partial results unless --allow-partial', async () => {
    const s = await setup({ partial: true });
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(2);
    expect(s.lines[0]).toMatch(/^error: results run-1 are partial/);
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, allowPartial: true, log: s.log })).exitCode).toBe(0);
  });

  it('refuses traces that do not belong to the results, and non-JSON trace lines', async () => {
    const short = await setup({}, 3);
    expect((await publishCommand({ results: short.resultsPath, traces: short.tracesPath, dataDir: short.dataDir, log: short.log })).exitCode).toBe(2);
    expect(short.lines[0]).toMatch(/traces file has 3 line\(s\) but the results count 4 run\(s\)/);
    const junk = await setup();
    await writeFile(junk.tracesPath, '{}\n{}\nnot json\n{}\n');
    expect((await publishCommand({ results: junk.resultsPath, traces: junk.tracesPath, dataDir: junk.dataDir, log: junk.log })).exitCode).toBe(2);
    expect(junk.lines[0]).toMatch(/line 3 is not JSON/);
    expect(existsSync(join(junk.dataDir, 'runs'))).toBe(false);
  });

  it('refuses to overwrite a published run, and names unreadable files', async () => {
    const s = await setup();
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(0);
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, log: s.log })).exitCode).toBe(2);
    expect(s.lines.at(-1)).toMatch(/already exists; refusing to overwrite a published run/);
    const missing = join(s.dir, 'nope.jsonl');
    expect((await publishCommand({ results: s.resultsPath, traces: missing, dataDir: join(s.dir, 'other'), log: s.log })).exitCode).toBe(2);
    expect(s.lines.at(-1)).toContain(missing);
  });

  it('refuses (exit 2, nothing written) when results or traces contain an OpenRouter key', async () => {
    const leaky = await setup();
    await writeFile(leaky.tracesPath, `${['{"a":1}', '{"b":"Bearer sk-or-v1-abcdef"}', '{}', '{}'].join('\n')}\n`);
    expect((await publishCommand({ results: leaky.resultsPath, traces: leaky.tracesPath, dataDir: leaky.dataDir, env: {}, log: leaky.log })).exitCode).toBe(2);
    expect(leaky.lines.at(-1)).toMatch(/^error: .*traces.*contains? an OpenRouter API key \(sk-or-\)/);
    expect(existsSync(join(leaky.dataDir, 'runs'))).toBe(false);

    const inResults = await setup({ runId: 'run-1' });
    const raw = JSON.parse(await readFile(inResults.resultsPath, 'utf8'));
    raw.suites[0].servers.neatcode.setup = 'KEY=sk-or-v1-zzz init';
    await writeFile(inResults.resultsPath, JSON.stringify(raw));
    expect((await publishCommand({ results: inResults.resultsPath, traces: inResults.tracesPath, dataDir: inResults.dataDir, env: {}, log: inResults.log })).exitCode).toBe(2);
    expect(inResults.lines.at(-1)).toMatch(/results/);

    const custom = await setup();
    const key = 'custom-format-secret-0123456789';
    await writeFile(custom.tracesPath, `${['{}', `{"x":"${key}"}`, '{}', '{}'].join('\n')}\n`);
    const res = await publishCommand({ results: custom.resultsPath, traces: custom.tracesPath, dataDir: custom.dataDir, env: { OPENROUTER_API_KEY: key }, log: custom.log });
    expect(res.exitCode).toBe(2);
    expect(custom.lines.at(-1)).toMatch(/OPENROUTER_API_KEY/);
    expect(custom.lines.join('\n')).not.toContain(key);
  });

  it('warns, but publishes, when traces contain /Users/ paths', async () => {
    const s = await setup();
    await writeFile(s.tracesPath, `${['{"p":"/Users/someone/project/x.ts"}', '{}', '{}', '{}'].join('\n')}\n`);
    expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, env: {}, log: s.log })).exitCode).toBe(0);
    expect(s.lines.some((l) => /^warning: .*traces.*\/Users\//.test(l))).toBe(true);
  });

  it('refuses a runId that is not a single safe path segment', async () => {
    for (const runId of ['../escape', 'a/b', '..', '.hidden', '']) {
      const s = await setup({ runId });
      expect((await publishCommand({ results: s.resultsPath, traces: s.tracesPath, dataDir: s.dataDir, env: {}, log: s.log })).exitCode).toBe(2);
      expect(s.lines.at(-1)).toMatch(/^error: invalid run id/);
      expect(existsSync(join(s.dataDir))).toBe(false);
    }
  });
});
