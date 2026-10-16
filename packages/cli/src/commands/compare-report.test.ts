import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Results } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { compareCommand } from './compare.js';
import { reportCommand } from './report.js';

async function files(entries: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-cmp-'));
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(entries)) {
    paths[name] = join(dir, name);
    await writeFile(paths[name]!, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { dir, paths };
}

const nc = { server: 'neatcode', model: 'acme/a' };
const opts = { maxSuccessDrop: 5, maxContextIncrease: 20, format: 'table' as const };

function v1(r: Results): unknown {
  return {
    ...r,
    schemaVersion: 1,
    suites: r.suites.map(({ judge: _judge, ...s }) => ({
      ...s,
      servers: Object.fromEntries(Object.entries(s.servers).map(([k, v]) => [k, { command: v.command }])),
      cells: s.cells.map(({ plannedRuns: _p, complete: _c, providerPromptTokensPerTask: _t, ...c }) => c),
    })),
  };
}

describe('compareCommand', () => {
  it('exits 1 on a regression and 0 otherwise, printing the comparison', async () => {
    const { paths } = await files({ 'base.json': results([cell(nc)]), 'same.json': results([cell(nc)]), 'worse.json': results([cell({ ...nc, successRate: 0.25 })]) });
    const lines: string[] = [];
    expect((await compareCommand({ ...opts, base: paths['base.json']!, head: paths['same.json']!, log: (l) => lines.push(l) })).exitCode).toBe(0);
    const worse = await compareCommand({ ...opts, base: paths['base.json']!, head: paths['worse.json']!, log: (l) => lines.push(l) });
    expect(worse.exitCode).toBe(1);
    expect(worse.comparison?.regressions).toBe(1);
    expect(lines.join('\n')).toMatch(/REGRESSION/);
  });

  it('accepts v1 results files', async () => {
    const { paths } = await files({ 'old.json': v1(results([cell(nc)])), 'new.json': results([cell(nc)]) });
    expect((await compareCommand({ ...opts, base: paths['old.json']!, head: paths['new.json']!, log: () => {} })).exitCode).toBe(0);
  });

  it('exits 2 naming the file for missing, unparseable, or invalid results, and for bad thresholds', async () => {
    const { dir, paths } = await files({ 'ok.json': results([cell(nc)]), 'bad.json': '{oops', 'v9.json': { schemaVersion: 9 } });
    for (const bad of [join(dir, 'missing.json'), paths['bad.json']!, paths['v9.json']!]) {
      const lines: string[] = [];
      expect((await compareCommand({ ...opts, base: paths['ok.json']!, head: bad, log: (l) => lines.push(l) })).exitCode).toBe(2);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: /);
      expect(lines[0]).toContain(bad);
    }
    const lines: string[] = [];
    expect((await compareCommand({ ...opts, maxSuccessDrop: -1, base: paths['ok.json']!, head: paths['ok.json']!, log: (l) => lines.push(l) })).exitCode).toBe(2);
    expect(lines[0]).toMatch(/^error: --max-success-drop/);
  });
});

describe('reportCommand', () => {
  it('prints a table or markdown, and exits 2 for a bad file', async () => {
    const { dir, paths } = await files({ 'r.json': results([cell(nc)]) });
    const lines: string[] = [];
    expect((await reportCommand({ results: paths['r.json']!, format: 'table', log: (l) => lines.push(l) })).exitCode).toBe(0);
    expect(lines[0]).toMatch(/^SUITE/);
    lines.length = 0;
    expect((await reportCommand({ results: paths['r.json']!, format: 'markdown', log: (l) => lines.push(l) })).exitCode).toBe(0);
    expect(lines[0]).toMatch(/^## mcp-evals results/);
    expect((await reportCommand({ results: join(dir, 'nope.json'), format: 'table', log: () => {} })).exitCode).toBe(2);
  });
});
