import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { alignColumns, ci, formatTable, pct, usd } from './table.js';

describe('formatting helpers', () => {
  it('formats percentages, intervals, and dollars', () => {
    expect(pct(0.756)).toBe('76%');
    expect(ci([0.3006, 0.9544])).toBe('[30–95%]');
    expect(usd(0.002)).toBe('$0.0020');
  });
  it('aligns columns', () => {
    expect(alignColumns([['A', 'BB'], ['ccc', 'd']])).toBe('A    BB\nccc  d');
  });
});

describe('formatTable', () => {
  it('renders a header, one row per cell with runs/planned, the notices, and the total', () => {
    const r = results(
      [
        cell({ server: 'neatcode', model: 'acme/a', contextTokensPerTask: { mean: 10, median: 12.4 }, costUsdPerTask: 0.002, stepsPerTask: 2 }),
        cell({ server: 'neatcode', model: 'acme/b', runs: 2, complete: false, successRate: null, successRateWithErrors: 0, successCi95: [0, 1], errorRate: 1 }),
      ],
      { partial: true, totalCostUsd: 0.012 },
    );
    const lines = formatTable(r).split('\n');
    expect(lines[0]).toMatch(/^SUITE\s+SERVER\s+MODEL\s+RUNS\s+SUCCESS\s+SUCCESS w\/ERR\s+95% CI\s+TOOL ACC\s+CTX TOK \(med\)\s+STEPS\s+\$\/TASK\s+ERRORS$/);
    expect(lines[1]).toMatch(/^code-navigation\s+neatcode\s+acme\/a\s+4\/4\s+75%\s+75%\s+\[30–95%\]\s+–\s+12\s+2\.0\s+\$0\.0020\s+0%$/);
    expect(lines[2]).toMatch(/^code-navigation\s+neatcode\s+acme\/b\s+2\/4\s+–\s+0%\s+\[0–100%\]\s+–\s+1000\s+3\.0\s+\$0\.0100\s+100%$/);
    expect(lines).toContain('PARTIAL: the run stopped (budget cap, out of credits, unknown cost or repeated provider errors) before every planned run finished.');
    expect(lines).toContain('INCOMPLETE: 1 cell(s) did not finish every planned run; do not compare them as if complete.');
    expect(lines.at(-1)).toBe('total cost $0.0120 · run run-1');
  });

  it('shows plain run counts for results upgraded from v1', () => {
    const lines = formatTable(results([cell({ server: 'neatcode', model: 'acme/a', plannedRuns: null, complete: false })])).split('\n');
    expect(lines[1]).toMatch(/^code-navigation\s+neatcode\s+acme\/a\s+4\s+75%/);
    expect(lines.some((l) => l.startsWith('INCOMPLETE'))).toBe(false);
  });
});
