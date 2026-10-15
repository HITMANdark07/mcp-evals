import type { RunRecord, Suite } from '../types.js';
import { mean, median } from '../util.js';
import type { Results } from './schema.js';
import { wilson } from './wilson.js';

export interface AggregateInput {
  records: RunRecord[];
  suites: Suite[];
  providerName: string;
  harnessVersion: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  partial: boolean;
  totalCostUsd: number;
}

type Cell = Results['suites'][number]['cells'][number];

export function aggregate(input: AggregateInput): Results {
  return {
    schemaVersion: 1,
    harnessVersion: input.harnessVersion,
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    partial: input.partial,
    totalCostUsd: input.totalCostUsd,
    suites: input.suites.map((suite) => {
      const recs = input.records.filter((r) => r.suite === suite.name);
      const cells: Cell[] = [];
      for (const server of Object.keys(suite.servers)) {
        for (const model of suite.models) {
          const rs = recs.filter((r) => r.server === server && r.model === model);
          if (rs.length > 0) cells.push(buildCell(suite, server, model, rs));
        }
      }
      return {
        suite: suite.name,
        suiteVersion: suite.version,
        fixture: suite.fixture ?? null,
        servers: Object.fromEntries(
          Object.entries(suite.servers).map(([name, s]) => [
            name,
            { ...(s.command !== undefined ? { command: s.command } : {}), ...(s.url !== undefined ? { url: s.url } : {}) },
          ]),
        ),
        models: suite.models.map((id) => ({ id, provider: input.providerName })),
        cells,
      };
    }),
  };
}

function buildCell(suite: Suite, server: string, model: string, rs: RunRecord[]): Cell {
  const completed = rs.filter((r) => r.outcome !== 'error');
  const passes = completed.filter((r) => r.outcome === 'pass').length;
  const n = completed.length;
  const toolVals = completed.map((r) => r.toolSelectionOk).filter((v): v is boolean => v !== null);
  const ctx = completed.map((r) => r.contextTokens);
  const tasks: Cell['tasks'] = [];
  for (const task of suite.tasks) {
    const tr = rs.filter((r) => r.task === task.id).sort((a, b) => a.repeat - b.repeat);
    if (tr.length === 0) continue;
    tasks.push({
      id: task.id,
      passes: tr.filter((r) => r.outcome === 'pass').length,
      fails: tr.filter((r) => r.outcome === 'fail').length,
      errors: tr.filter((r) => r.outcome === 'error').length,
      traceRef: tr[0]!.runKey,
    });
  }
  return {
    server,
    model,
    runs: rs.length,
    successRate: n === 0 ? 0 : passes / n,
    successCi95: wilson(passes, n),
    toolAccuracy: toolVals.length === 0 ? null : toolVals.filter(Boolean).length / toolVals.length,
    contextTokensPerTask: { mean: mean(ctx), median: median(ctx) },
    stepsPerTask: mean(completed.map((r) => r.steps)),
    latencyMsP50: median(completed.map((r) => r.latencyMs)),
    costUsdPerTask: mean(completed.map((r) => r.costUsd)),
    errorRate: (rs.length - n) / rs.length,
    tasks,
  };
}
