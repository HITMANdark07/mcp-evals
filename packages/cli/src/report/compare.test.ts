import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { compareResults, formatComparison } from './compare.js';

const t = { maxSuccessDropPts: 5, maxContextIncreasePct: 20 };
const one = (over: Parameters<typeof cell>[0]) => results([cell(over)]);
const nc = { server: 'neatcode', model: 'acme/a' };

describe('compareResults', () => {
  it('is ok when nothing moved', () => {
    const c = compareResults(one(nc), one(nc), t);
    expect(c.regressions).toBe(0);
    expect(c.cells).toEqual([expect.objectContaining({ ...nc, suite: 'code-navigation', status: 'ok', successDeltaPts: 0, contextChangePct: 0, reasons: [] })]);
  });

  // Review Focus 4
  it('flags a success drop above the threshold, but not one exactly at it', () => {
    const base = one({ ...nc, successRate: 0.75 });
    expect(compareResults(base, one({ ...nc, successRate: 0.7 }), t).regressions).toBe(0);
    const c = compareResults(base, one({ ...nc, successRate: 0.6999 }), t);
    expect(c.regressions).toBe(1);
    expect(c.cells[0]).toMatchObject({ status: 'regression', reasons: [expect.stringMatching(/^success dropped 5\.0 pts \(max 5\)$/)] });
  });

  it('flags context growth above the threshold, and skips the check when the base median is 0', () => {
    const base = one({ ...nc, contextTokensPerTask: { mean: 1000, median: 1000 } });
    expect(compareResults(base, one({ ...nc, contextTokensPerTask: { mean: 1200, median: 1200 } }), t).regressions).toBe(0);
    const c = compareResults(base, one({ ...nc, contextTokensPerTask: { mean: 1201, median: 1201 } }), t);
    expect(c.cells[0]).toMatchObject({ status: 'regression', reasons: [expect.stringMatching(/context tokens rose 20\.1%/)] });
    const zero = compareResults(one({ ...nc, contextTokensPerTask: { mean: 0, median: 0 } }), one(nc), t);
    expect(zero.cells[0]).toMatchObject({ status: 'ok', contextChangePct: null });
  });

  it('does not compare null success rates', () => {
    const c = compareResults(one({ ...nc, successRate: null }), one({ ...nc, successRate: 0 }), t);
    expect(c.cells[0]).toMatchObject({ status: 'ok', successDeltaPts: null });
  });

  it('reports cells missing on either side without failing', () => {
    const base = results([cell(nc), cell({ server: 'filesystem', model: 'acme/a' })]);
    const head = results([cell(nc), cell({ server: 'neatcode', model: 'acme/b' })]);
    const c = compareResults(base, head, t);
    expect(c.regressions).toBe(0);
    expect(c.cells.map((x) => `${x.server}/${x.model}:${x.status}`)).toEqual([
      'neatcode/acme/a:ok', 'neatcode/acme/b:missing_in_base', 'filesystem/acme/a:missing_in_head',
    ]);
  });

  it('reports incomplete cells instead of judging them, but compares v1 cells of unknown completeness', () => {
    const c = compareResults(one(nc), one({ ...nc, runs: 2, complete: false, successRate: 0 }), t);
    expect(c.regressions).toBe(0);
    expect(c.cells[0]).toMatchObject({ status: 'incomplete', reasons: ['head incomplete (2/4 runs)'] });
    const v1 = compareResults(one({ ...nc, plannedRuns: null, complete: false }), one({ ...nc, plannedRuns: null, complete: false, successRate: 0.5 }), t);
    expect(v1.cells[0]).toMatchObject({ status: 'regression' });
  });
});

describe('formatComparison', () => {
  const c = compareResults(one(nc), one({ ...nc, successRate: 0.5 }), t);
  it('renders a table with a summary', () => {
    const out = formatComparison(c, 'table');
    expect(out.split('\n')[0]).toMatch(/^SUITE\s+SERVER\s+MODEL\s+STATUS\s+SUCCESS\s+Δ PTS\s+CTX TOK \(med\)\s+Δ CTX\s+NOTES$/);
    expect(out).toMatch(/code-navigation\s+neatcode\s+acme\/a\s+REGRESSION\s+75% → 50%\s+-25\.0/);
    expect(out.split('\n').at(-1)).toBe('1 regression(s) in 1 cell(s) · max success drop 5 pts · max context increase 20%');
  });
  it('renders markdown and json', () => {
    const md = formatComparison(c, 'markdown').split('\n');
    expect(md[0]).toBe('| SUITE | SERVER | MODEL | STATUS | SUCCESS | Δ PTS | CTX TOK (med) | Δ CTX | NOTES |');
    expect(md[1]).toBe('|---|---|---|---|---|---|---|---|---|');
    expect(md[2]).toContain('| REGRESSION |');
    expect(JSON.parse(formatComparison(c, 'json'))).toEqual(c);
  });
});
