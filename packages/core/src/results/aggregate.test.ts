import { describe, expect, it } from 'vitest';
import type { PlannedCell, RunRecord, Suite, TraceEvent } from '../types.js';
import { aggregate, type AggregateInput } from './aggregate.js';
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
function rec(over: Partial<RunRecord> = {}, events: TraceEvent[] = []): RunRecord {
  const base = {
    runKey: `k${n++}`, suite: 'demo', server: 'fake', model: 'm/a', task: 't1', repeat: 0,
    outcome: 'pass' as const, end: 'final_answer' as const, graders: [], attempts: 1,
    costUsd: 0.01, steps: 2, contextTokens: 100, latencyMs: 50,
  };
  return { ...base, toolSelectionOk: null, trace: { ...base, events, serverStderr: '' }, ...over };
}

const call = (promptTokens: number): TraceEvent => ({
  type: 'model_call', step: 1, t: 0, latencyMs: 1, promptTokens, completionTokens: 1, costUsd: 0,
});

const plan = (server: string, model: string, runs: number): PlannedCell => ({ suite: 'demo', server, model, runs });

const meta: Omit<AggregateInput, 'records' | 'suites' | 'planned'> = {
  providerName: 'mock', harnessVersion: '0.0.0', runId: 'r1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:01:00.000Z', partial: false, totalCostUsd: 0.05,
};

describe('aggregate', () => {
  it('builds v2 cells with success, CI, tool accuracy, stats, errors, completeness, and tasks', () => {
    const records = [
      rec({ task: 't1', repeat: 1, runKey: 'r-t1-1', toolSelectionOk: true, contextTokens: 100, steps: 2 }),
      rec({ task: 't1', repeat: 0, runKey: 'r-t1-0', toolSelectionOk: false, contextTokens: 300, steps: 4, outcome: 'fail', end: 'max_steps' }),
      rec({ task: 't2', repeat: 0, runKey: 'r-t2-0', contextTokens: 200, steps: 3 }),
      rec({ task: 't2', repeat: 1, runKey: 'r-t2-1', outcome: 'error', end: 'infra_error', contextTokens: 9999 }),
      rec({ model: 'm/b', task: 't1' }),
    ];
    const results = aggregate({ records, suites: [suite], planned: [plan('fake', 'm/a', 4), plan('fake', 'm/b', 2)], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    expect(results.schemaVersion).toBe(2);
    expect(results.suites[0]!.fixture).toBeNull();
    expect(results.suites[0]!.judge).toBeNull();
    expect(results.suites[0]!.models).toEqual([{ id: 'm/a', provider: 'mock' }, { id: 'm/b', provider: 'mock' }]);

    const cells = results.suites[0]!.cells;
    expect(cells.map((c) => `${c.server}|${c.model}`)).toEqual(['fake|m/a', 'fake|m/b']);
    const a = cells[0]!;
    expect(a).toMatchObject({ runs: 4, plannedRuns: 4, complete: true });
    expect(a.successRate).toBeCloseTo(2 / 3, 6);
    expect(a.successCi95).toEqual(expect.arrayContaining([expect.any(Number), expect.any(Number)]));
    expect(a.errorRate).toBe(0.25);
    expect(a.toolAccuracy).toBe(0.5);
    expect(a.contextTokensPerTask).toEqual({ mean: 200, median: 200 });
    expect(a.providerPromptTokensPerTask).toEqual({ mean: 0, median: 0 });
    expect(a.stepsPerTask).toBe(3);
    expect(a.tasks).toEqual([
      { id: 't1', passes: 1, fails: 1, errors: 0, traceRef: 'r-t1-0' },
      { id: 't2', passes: 1, fails: 0, errors: 1, traceRef: 'r-t2-0' },
    ]);
    expect(cells[1]).toMatchObject({ runs: 1, plannedRuns: 2, complete: false, toolAccuracy: null });
  });

  it('reports null success with CI [0,1] when every run errored', () => {
    const results = aggregate({ records: [rec({ outcome: 'error', end: 'infra_error' })], suites: [suite], planned: [plan('fake', 'm/a', 1)], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    const c = results.suites[0]!.cells[0]!;
    expect(c.successRate).toBeNull();
    expect(c.successCi95).toEqual([0, 1]);
    expect(c.errorRate).toBe(1);
    expect(c.complete).toBe(true);
  });

  it('lists planned cells that never ran as incomplete', () => {
    const results = aggregate({ records: [], suites: [suite], planned: [plan('other', 'm/b', 2)], ...meta });
    expect(() => ResultsSchema.parse(results)).not.toThrow();
    expect(results.suites[0]!.cells).toEqual([
      expect.objectContaining({ server: 'other', model: 'm/b', runs: 0, plannedRuns: 2, complete: false, successRate: null, errorRate: 0, tasks: [] }),
    ]);
  });

  it('records provider pins, the judge, server versions, and provider-reported prompt tokens', () => {
    const pinned: Suite = { ...suite, modelPins: { 'm/a': 'acme' }, judge: { id: 'j/judge', provider: 'acme' } };
    const records = [
      rec({ serverVersion: '1.2.3' }, [call(100), call(300)]),
      rec({ repeat: 1 }, [call(1000)]),
      rec({ repeat: 2, outcome: 'error', end: 'infra_error' }, [call(99999)]),
    ];
    const r = aggregate({ records, suites: [pinned], planned: [plan('fake', 'm/a', 3)], ...meta });
    const s = r.suites[0]!;
    expect(s.models).toEqual([{ id: 'm/a', provider: 'acme' }, { id: 'm/b', provider: 'mock' }]);
    expect(s.judge).toEqual({ id: 'j/judge', provider: 'acme' });
    expect(s.servers).toEqual({ fake: { command: 'node', version: '1.2.3' }, other: { command: 'node', version: null } });
    // 100+300 and 1000; the error run is excluded like every other per-task stat.
    expect(s.cells[0]!.providerPromptTokensPerTask).toEqual({ mean: 700, median: 700 });
    expect(s.cells[0]!.complete).toBe(true);
  });
});
