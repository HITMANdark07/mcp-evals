import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { readResults } from './read.js';
import { ResultsSchema, type ResultsV1 } from './schema.js';

const v1: ResultsV1 = {
  schemaVersion: 1, harnessVersion: '0.0.0', runId: 'r1',
  startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:01:00.000Z', partial: false, totalCostUsd: 0.01,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: { fake: { command: 'node' } }, models: [{ id: 'm/a', provider: 'mock' }],
    cells: [{
      server: 'fake', model: 'm/a', runs: 2, successRate: 0.5, successCi95: [0.09, 0.91], toolAccuracy: null,
      contextTokensPerTask: { mean: 10, median: 10 }, stepsPerTask: 2, latencyMsP50: 5, costUsdPerTask: 0.005, errorRate: 0,
      tasks: [{ id: 't1', passes: 1, fails: 1, errors: 0, traceRef: 'k1' }],
    }],
  }],
};

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('readResults', () => {
  it('upgrades v1 results to v2, filling the new fields with null/false', () => {
    const r = readResults(copy(v1));
    expect(() => ResultsSchema.parse(r)).not.toThrow();
    expect(r.schemaVersion).toBe(2);
    expect(r.suites[0]!.servers.fake).toEqual({ command: 'node', version: null });
    expect(r.suites[0]!.judge).toBeNull();
    expect(r.suites[0]!.cells[0]).toMatchObject({
      runs: 2, plannedRuns: null, complete: false, providerPromptTokensPerTask: null, successRate: 0.5,
    });
  });

  it('returns v2 results unchanged', () => {
    const v2 = readResults(copy(v1));
    expect(readResults(copy(v2))).toEqual(v2);
  });

  it('rejects unknown versions and invalid content with a ConfigError naming the problem', () => {
    expect(() => readResults({ schemaVersion: 3 })).toThrow(ConfigError);
    expect(() => readResults({ schemaVersion: 3 })).toThrow(/unsupported results schemaVersion 3/);
    expect(() => readResults('nope')).toThrow(/unsupported results schemaVersion null/);
    expect(() => readResults({ ...copy(v1), runId: 42 })).toThrow(/invalid results: runId/);
  });
});
