import type { Results } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { ci, formatTable, pct, usd } from './table.js';

const results: Results = {
  schemaVersion: 2, harnessVersion: '0.0.0', runId: 'run-1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:00:01.000Z', partial: true, totalCostUsd: 0.012,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: { fake: { command: 'node', version: null } },
    models: [{ id: 'mock/a', provider: 'mock' }], judge: null,
    cells: [{
      server: 'fake', model: 'mock/a', runs: 4, plannedRuns: 4, complete: true, successRate: 0.75, successCi95: [0.3006, 0.9544], toolAccuracy: null,
      contextTokensPerTask: { mean: 10, median: 12.4 }, providerPromptTokensPerTask: null, stepsPerTask: 2, latencyMsP50: 5, costUsdPerTask: 0.002, errorRate: 0,
      tasks: [],
    }, {
      server: 'fake', model: 'mock/b', runs: 2, plannedRuns: 2, complete: true, successRate: null, successCi95: [0, 1], toolAccuracy: null,
      contextTokensPerTask: { mean: 0, median: 0 }, providerPromptTokensPerTask: null, stepsPerTask: 0, latencyMsP50: 0, costUsdPerTask: 0, errorRate: 1,
      tasks: [],
    }],
  }],
};

describe('formatting helpers', () => {
  it('formats percentages, intervals, and dollars', () => {
    expect(pct(0.756)).toBe('76%');
    expect(ci([0.3006, 0.9544])).toBe('[30–95%]');
    expect(usd(0.002)).toBe('$0.0020');
  });
});

describe('formatTable', () => {
  it('renders a header, one row per cell, the partial notice, and the total', () => {
    const lines = formatTable(results).split('\n');
    expect(lines[0]).toMatch(/^SUITE\s+SERVER\s+MODEL\s+RUNS\s+SUCCESS\s+95% CI\s+TOOL ACC\s+CTX TOK \(med\)\s+STEPS\s+\$\/TASK\s+ERRORS$/);
    expect(lines[1]).toMatch(/^demo\s+fake\s+mock\/a\s+4\s+75%\s+\[30–95%\]\s+–\s+12\s+2\.0\s+\$0\.0020\s+0%$/);
    expect(lines[2]).toMatch(/^demo\s+fake\s+mock\/b\s+2\s+–\s+\[0–100%\]\s+–\s+0\s+0\.0\s+\$0\.0000\s+100%$/);
    expect(lines).toContain('PARTIAL: budget cap reached before all runs finished.');
    expect(lines.at(-1)).toBe('total cost $0.0120 · run run-1');
  });
});
