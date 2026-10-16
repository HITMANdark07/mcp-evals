import type { Results } from '@mcp-evals/core';

export type Cell = Results['suites'][number]['cells'][number];

export function cell(over: Partial<Cell> & Pick<Cell, 'server' | 'model'>): Cell {
  return {
    runs: 4, plannedRuns: 4, complete: true, successRate: 0.75, successRateWithErrors: 0.75, successCi95: [0.3006, 0.9544], toolAccuracy: null,
    contextTokensPerTask: { mean: 1000, median: 1000 }, providerPromptTokensPerTask: { mean: 5000, median: 5000 },
    stepsPerTask: 3, latencyMsP50: 1200, costUsdPerTask: 0.01, errorRate: 0, tasks: [],
    ...over,
  };
}

export function results(cells: Cell[], over: Partial<Results> = {}): Results {
  return {
    schemaVersion: 2, harnessVersion: '0.0.0', harnessCommit: null, runId: 'run-1',
    startedAt: '2026-10-16T00:00:00.000Z', finishedAt: '2026-10-16T00:10:00.000Z', partial: false, totalCostUsd: 0.04,
    suites: [{
      suite: 'code-navigation', suiteVersion: 1,
      fixture: { git: 'https://github.com/honojs/hono', ref: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa' },
      servers: {
        neatcode: { command: 'npx', args: ['-y', '@neatcodeai/mcp@0.1.4'], setup: 'npx -y @neatcodeai/cli@0.1.4 init', version: '0.1.4' },
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '{fixture}'], setup: null, version: null },
      },
      models: [{ id: 'acme/a', provider: 'acme' }], judge: null, cells,
    }],
    ...over,
  };
}
