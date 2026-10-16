import { describe, expect, it } from 'vitest';
import type { RunRecord, Suite } from '../types.js';
import { aggregate } from './aggregate.js';
import { ResultsSchema } from './schema.js';
import { wilson } from './wilson.js';

describe('wilson', () => {
  it('matches reference values', () => {
    const [lo1, hi1] = wilson(5, 10);
    expect(lo1).toBeCloseTo(0.2366, 4);
    expect(hi1).toBeCloseTo(0.7634, 4);
    const [lo2, hi2] = wilson(0, 10);
    expect(lo2).toBe(0);
    expect(hi2).toBeCloseTo(0.2775, 4);
    const [lo3, hi3] = wilson(10, 10);
    expect(lo3).toBeCloseTo(0.7225, 4);
    expect(hi3).toBe(1);
  });
  it('returns [0, 1] when n is 0', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

const suite: Suite = {
  name: 'demo',
  version: 2,
  source: 'demo.yaml',
  servers: {
    fake: { command: 'node', args: [], env: {}, headers: {} },
    other: { command: 'node', args: [], env: {}, headers: {} },
  },
  models: ['m/a', 'm/b'],
  modelPins: {},
  defaults: { repeats: 2, maxSteps: 5, timeoutS: 10, temperature: 0, toolTimeoutS: 60 },
  tasks: [
    { id: 't1', prompt: 'p', graders: [] },
    { id: 't2', prompt: 'q', graders: [] },
  ],
};

let n = 0;
function rec(over: Partial<RunRecord>): RunRecord {
  const key = `k${n++}`;
  return {
    runKey: key, suite: 'demo', server: 'fake', model: 'm/a', task: 't1', repeat: 0,
    outcome: 'pass', end: 'final_answer', graders: [], toolSelectionOk: null,
    steps: 2, contextTokens: 100, latencyMs: 50, costUsd: 0.01, attempts: 1,
    trace: {
      runKey: key, suite: 'demo', server: 'fake', model: 'm/a', task: 't1', repeat: 0, events: [], serverStderr: '',
      outcome: 'pass', end: 'final_answer', graders: [], attempts: 1, costUsd: 0.01, steps: 2, contextTokens: 100, latencyMs: 50,
    },
    ...over,
  };
}

const meta = {
  providerName: 'mock', harnessVersion: '0.0.0', runId: 'r1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:01:00.000Z', partial: false, totalCostUsd: 0.05,
};

describe('aggregate', () => {
  it('builds cells with success, CI, tool accuracy, stats, errors, and tasks', () => {
    const records = [
      rec({ task: 't1', repeat: 1, runKey: 'r-t1-1', toolSelectionOk: true, contextTokens: 100, steps: 2 }),
      rec({ task: 't1', repeat: 0, runKey: 'r-t1-0', toolSelectionOk: false, contextTokens: 300, steps: 4, outcome: 'fail', end: 'max_steps' }),
      rec({ task: 't2', repeat: 0, runKey: 'r-t2-0', contextTokens: 200, steps: 3 }),
      rec({ task: 't2', repeat: 1, runKey: 'r-t2-1', outcome: 'error', end: 'infra_error', contextTokens: 9999 }),
      rec({ model: 'm/b', task: 't1' }),
    ];
    const results = aggregate({ records, suites: [suite], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    expect(results.schemaVersion).toBe(1);
    expect(results.suites[0]!.fixture).toBeNull();
    expect(results.suites[0]!.models).toEqual([{ id: 'm/a', provider: 'mock' }, { id: 'm/b', provider: 'mock' }]);

    const cells = results.suites[0]!.cells;
    expect(cells.map((c) => `${c.server}|${c.model}`)).toEqual(['fake|m/a', 'fake|m/b']);
    const a = cells[0]!;
    expect(a.runs).toBe(4);
    expect(a.successRate).toBeCloseTo(2 / 3, 6);
    expect(a.successCi95).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
    expect(a.errorRate).toBe(0.25);
    expect(a.toolAccuracy).toBe(0.5);
    expect(a.contextTokensPerTask).toEqual({ mean: 200, median: 200 });
    expect(a.stepsPerTask).toBe(3);
    expect(a.tasks).toEqual([
      { id: 't1', passes: 1, fails: 1, errors: 0, traceRef: 'r-t1-0' },
      { id: 't2', passes: 1, fails: 0, errors: 1, traceRef: 'r-t2-0' },
    ]);
    expect(cells[1]!.toolAccuracy).toBeNull();
  });

  it('reports null success with CI [0,1] when every run errored', () => {
    const results = aggregate({ records: [rec({ outcome: 'error', end: 'infra_error' })], suites: [suite], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    const c = results.suites[0]!.cells[0]!;
    expect(c.successRate).toBeNull();
    expect(c.successCi95).toEqual([0, 1]);
    expect(c.errorRate).toBe(1);
  });
});
