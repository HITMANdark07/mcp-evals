import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Results } from '@mcp-evals/core';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'build-site.mjs');
const DATA = join(ROOT, 'data');

function build(data: string, out: string): string {
  return execFileSync(process.execPath, [SCRIPT, '--data', data, '--out', out], { encoding: 'utf8' });
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** The <tr> of one server × model cell in the cells table. */
function row(html: string, server: string, model: string): string {
  const start = html.indexOf(`<tr data-cell="${server}|${model}"`);
  expect(start, `row for ${server} / ${model}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

describe('build-site against the published data/', () => {
  let out: string;
  let html: string;
  let latest: Results;
  const published = readdirSync(join(DATA, 'runs')).filter((d) => existsSync(join(DATA, 'runs', d, 'results.json')));

  beforeAll(async () => {
    out = join(await mkdtemp(join(tmpdir(), 'site-')), 'site-dist');
    build(DATA, out);
    html = await readFile(join(out, 'index.html'), 'utf8');
    latest = JSON.parse(await readFile(join(DATA, 'latest.json'), 'utf8')) as Results;
  });

  it('writes index.html, the CSS and JS, and the data files', () => {
    for (const f of ['index.html', 'style.css', 'app.js', 'render.js', 'data/index.json', 'data/latest.json']) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    expect(html).toContain('<title>mcp-arena leaderboard</title>');
  });

  it('lists every published run, latest first, with its results and traces copied', async () => {
    expect(published.length).toBeGreaterThan(0);
    const index = JSON.parse(await readFile(join(out, 'data', 'index.json'), 'utf8')) as { runId: string; startedAt: string; latest: boolean }[];
    expect(index.map((r) => r.runId).sort()).toEqual([...published].sort());
    expect([...index].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => r.runId)).toEqual(index.map((r) => r.runId));
    expect(index.filter((r) => r.latest).map((r) => r.runId)).toEqual([latest.runId]);
    for (const id of published) {
      expect(html).toContain(`<option value="${id}"`);
      expect(existsSync(join(out, 'data', 'runs', id, 'results.json'))).toBe(true);
      if (existsSync(join(DATA, 'runs', id, 'traces.jsonl.gz'))) expect(existsSync(join(out, 'data', 'runs', id, 'traces.jsonl.gz'))).toBe(true);
    }
    expect(html).toContain(`href="data/runs/${latest.runId}/results.json"`);
    expect(html).toContain(`href="data/runs/${latest.runId}/traces.jsonl.gz"`);
  });

  it("renders the latest run's cells with their numbers", () => {
    const cells = latest.suites.flatMap((s) => s.cells);
    expect(cells).toHaveLength(6);
    for (const c of cells) {
      const r = row(html, c.server, c.model);
      expect(r).toContain(`${pct(c.successRate!)}</span> <span class="ci">[${Math.round(c.successCi95[0] * 100)}–${Math.round(c.successCi95[1] * 100)}%]`);
      expect(r).toContain(`>${pct(c.successRateWithErrors!)}<`);
      expect(r).toContain(`>${pct(c.invalidToolCallRate!)}<`);
      expect(r).toContain(`>${Math.round(c.contextTokensPerTask.median).toLocaleString('en-US')}<`);
      expect(r).toContain(`>${Math.round(c.providerPromptTokensPerTask!.median).toLocaleString('en-US')}<`);
      expect(r).toContain(`>${c.stepsPerTask.toFixed(1)}<`);
      expect(r).toContain(`>${(c.latencyMsP50 / 1000).toFixed(1)} s<`);
      expect(r).toContain(`>$${c.costUsdPerTask.toFixed(4)}<`);
      expect(r).toContain(`>${c.runs}/${c.plannedRuns}`);
    }
    // Spot-check against the numbers in the README.
    const sol = row(html, 'neatcode', 'openai/gpt-6.1-sol');
    for (const s of ['100%', '[86–100%]', '3,235', '35,716', '19.1 s', '$0.0214', '24/24']) expect(sol).toContain(s);
    expect(row(html, 'filesystem', 'qwen/qwen3.8-flash')).toContain('42%');
  });

  it('shows the provenance and the caveats', () => {
    expect(html).toContain(latest.harnessCommit!);
    expect(html).toContain(`$${latest.totalCostUsd.toFixed(2)}`);
    expect(html).toContain('The harness author also wrote NeatCode');
    expect(html).toMatch(/intervals are optimistic/);
    expect(html).toContain('docs/methodology.md');
    expect(html).toContain('Per-task breakdown');
  });

  it('ships no local paths or API keys, including inside the gzipped traces', async () => {
    for (const f of files(out)) {
      let buf = await readFile(f);
      if (f.endsWith('.gz')) buf = gunzipSync(buf);
      const text = buf.toString('utf8');
      expect(text.includes('/Users/'), f).toBe(false);
      expect(text.includes('sk-or-'), f).toBe(false);
    }
  });
});

describe('build-site with several runs', () => {
  it('lists runs newest first, keeps latest.json as the default, and flags partial runs and incomplete cells', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-multi-'));
    const data = join(dir, 'data');
    await cp(DATA, data, { recursive: true });
    const base = JSON.parse(await readFile(join(DATA, 'latest.json'), 'utf8')) as Results;
    const partial: Results = structuredClone(base);
    partial.runId = '2099-01-01T00-00-00-000Z-partial';
    partial.startedAt = '2099-01-01T00:00:00.000Z';
    partial.partial = true;
    const cell = partial.suites[0]!.cells[0]!;
    cell.runs = 10;
    cell.complete = false;
    await mkdir(join(data, 'runs', partial.runId), { recursive: true });
    await writeFile(join(data, 'runs', partial.runId, 'results.json'), JSON.stringify(partial));

    const out = join(dir, 'site-dist');
    build(data, out);
    const html = await readFile(join(out, 'index.html'), 'utf8');
    const index = JSON.parse(await readFile(join(out, 'data', 'index.json'), 'utf8')) as { runId: string; partial: boolean; incompleteCells: number }[];
    expect(index[0]).toMatchObject({ runId: partial.runId, partial: true, incompleteCells: 1 });
    expect(html.indexOf(`<option value="${partial.runId}"`)).toBeLessThan(html.indexOf(`<option value="${base.runId}"`));
    expect(html).toContain(`<option value="${base.runId}" selected>`);
    expect(html).toMatch(/· partial<\/option>/);
    // The partial run is embedded for the picker; its warnings come from the shared renderer.
    const embedded = JSON.parse(html.slice(html.indexOf('>', html.indexOf('id="mcp-arena-data"')) + 1, html.lastIndexOf('</script>'))) as {
      results: Record<string, Results>;
    };
    // Every published run plus the synthetic partial one.
    expect(Object.keys(embedded.results).sort()).toEqual([...readdirSync(join(DATA, 'runs')), partial.runId].sort());
    const render = (await import(join(ROOT, 'site', 'render.js'))) as { renderRun: (r: Results, info: object) => string };
    const partialHtml = render.renderRun(partial, {});
    expect(partialHtml).toContain('Partial run:');
    expect(partialHtml).toContain('Incomplete cells:');
    expect(row(partialHtml, cell.server, cell.model)).toContain('10/24 <span class="badge badge-warn">incomplete</span>');
  });

  it('refuses to build when the output would contain a local path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-leak-'));
    const data = join(dir, 'data');
    await cp(DATA, data, { recursive: true });
    const r = JSON.parse(await readFile(join(DATA, 'latest.json'), 'utf8')) as Results;
    r.suites[0]!.servers['neatcode']!.args = ['/Users/someone/repo'];
    await writeFile(join(data, 'latest.json'), JSON.stringify(r));
    expect(() => execFileSync(process.execPath, [SCRIPT, '--data', data, '--out', join(dir, 'out')], { stdio: 'pipe' })).toThrow(/refusing to publish/);
  });
});
