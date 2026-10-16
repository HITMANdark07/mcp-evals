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
});
