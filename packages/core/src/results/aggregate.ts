import type { PlannedCell, RunRecord, Suite } from '../types.js';
import { mean, median } from '../util.js';
import type { Results } from './schema.js';
import { wilson } from './wilson.js';

export interface AggregateInput {
  records: RunRecord[];
  suites: Suite[];
  /** The full plan, including runs a resumed run took from its cache. */
  planned: PlannedCell[];
  /** Provider label for models without a pin (e.g. "mock"). */
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
    schemaVersion: 2,
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
          const planned = input.planned.find((p) => p.suite === suite.name && p.server === server && p.model === model)?.runs ?? 0;
          if (rs.length > 0 || planned > 0) cells.push(buildCell(suite, server, model, rs, planned));
        }
      }
      return {
        suite: suite.name,
        suiteVersion: suite.version,
        fixture: suite.fixture ?? null,
        servers: Object.fromEntries(
          Object.entries(suite.servers).map(([name, s]) => [
            name,
            {
              ...(s.command !== undefined ? { command: s.command } : {}),
              ...(s.url !== undefined ? { url: s.url } : {}),
              version: recs.find((r) => r.server === name && r.serverVersion !== undefined)?.serverVersion ?? null,
            },
          ]),
        ),
        models: suite.models.map((id) => ({ id, provider: suite.modelPins[id] ?? input.providerName })),
        judge: suite.judge ? { id: suite.judge.id, provider: suite.judge.provider } : null,
        cells,
      };
    }),
  };
}

/** Provider-reported prompt tokens summed over the run's agent model calls (judge calls are not in the trace). */
function providerPromptTokens(r: RunRecord): number {
  return r.trace.events.reduce((sum, e) => (e.type === 'model_call' ? sum + e.promptTokens : sum), 0);
}

function buildCell(suite: Suite, server: string, model: string, rs: RunRecord[], plannedRuns: number): Cell {
  const completed = rs.filter((r) => r.outcome !== 'error');
  const passes = completed.filter((r) => r.outcome === 'pass').length;
  const n = completed.length;
  const toolVals = completed.map((r) => r.toolSelectionOk).filter((v): v is boolean => v !== null);
  const ctx = completed.map((r) => r.contextTokens);
  const prompt = completed.map(providerPromptTokens);
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
    plannedRuns,
    complete: rs.length === plannedRuns,
    successRate: n === 0 ? null : passes / n,
    successCi95: wilson(passes, n),
    toolAccuracy: toolVals.length === 0 ? null : toolVals.filter(Boolean).length / toolVals.length,
    contextTokensPerTask: { mean: mean(ctx), median: median(ctx) },
    providerPromptTokensPerTask: { mean: mean(prompt), median: median(prompt) },
    stepsPerTask: mean(completed.map((r) => r.steps)),
    latencyMsP50: median(completed.map((r) => r.latencyMs)),
    costUsdPerTask: mean(completed.map((r) => r.costUsd)),
    errorRate: rs.length === 0 ? 0 : (rs.length - n) / rs.length,
    tasks,
  };
}
