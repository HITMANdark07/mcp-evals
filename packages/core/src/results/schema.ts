import { z } from 'zod';

const Stat = z.object({ mean: z.number(), median: z.number() });
const TaskCounts = z.object({
  id: z.string(),
  passes: z.number().int().nonnegative(),
  fails: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  traceRef: z.string(),
});
const ModelInfo = z.object({ id: z.string(), provider: z.string() });

/** results.json schema v2 (M2): the source of truth for the CLI, the Action, the leaderboard and the portfolio. */
export const ResultsSchema = z.object({
  schemaVersion: z.literal(2),
  harnessVersion: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** true when the budget cap or an out-of-credits stop left planned runs unexecuted. */
  partial: z.boolean(),
  totalCostUsd: z.number().nonnegative(),
  suites: z.array(
    z.object({
      suite: z.string(),
      suiteVersion: z.number().int(),
      fixture: z.object({ git: z.string(), ref: z.string() }).nullable(),
      servers: z.record(
        z.string(),
        z.object({ command: z.string().optional(), url: z.string().optional(), version: z.string().nullable() }),
      ),
      /** Pinned OpenRouter provider slug per model (the provider name for unpinned mock models). */
      models: z.array(ModelInfo),
      judge: ModelInfo.nullable(),
      cells: z.array(
        z.object({
          server: z.string(),
          model: z.string(),
          /** Every record in the cell, including error outcomes. */
          runs: z.number().int().nonnegative(),
          /** Runs the plan scheduled for this cell; null only in results upgraded from v1. */
          plannedRuns: z.number().int().nonnegative().nullable(),
          /** runs === plannedRuns. Always false in results upgraded from v1. */
          complete: z.boolean(),
          /** null when the cell has no completed (pass/fail) runs. */
          successRate: z.number().min(0).max(1).nullable(),
          successCi95: z.tuple([z.number(), z.number()]),
          toolAccuracy: z.number().min(0).max(1).nullable(),
          /** Headline: o200k_base tokens returned by tool calls, per run. */
          contextTokensPerTask: Stat,
          /** Secondary: provider-reported prompt tokens summed over the run's model calls; null when upgraded from v1. */
          providerPromptTokensPerTask: Stat.nullable(),
          stepsPerTask: z.number(),
          latencyMsP50: z.number(),
          costUsdPerTask: z.number(),
          errorRate: z.number().min(0).max(1),
          tasks: z.array(TaskCounts),
        }),
      ),
    }),
  ),
});

export type Results = z.infer<typeof ResultsSchema>;

/** results.json schema v1 (M1); readResults() upgrades it to v2. */
export const ResultsV1Schema = z.object({
  schemaVersion: z.literal(1),
  harnessVersion: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  partial: z.boolean(),
  totalCostUsd: z.number().nonnegative(),
  suites: z.array(
    z.object({
      suite: z.string(),
      suiteVersion: z.number().int(),
      fixture: z.object({ git: z.string(), ref: z.string() }).nullable(),
      servers: z.record(z.string(), z.object({ command: z.string().optional(), url: z.string().optional() })),
      models: z.array(ModelInfo),
      cells: z.array(
        z.object({
          server: z.string(),
          model: z.string(),
          runs: z.number().int().nonnegative(),
          successRate: z.number().min(0).max(1).nullable(),
          successCi95: z.tuple([z.number(), z.number()]),
          toolAccuracy: z.number().min(0).max(1).nullable(),
          contextTokensPerTask: Stat,
          stepsPerTask: z.number(),
          latencyMsP50: z.number(),
          costUsdPerTask: z.number(),
          errorRate: z.number().min(0).max(1),
          tasks: z.array(z.object({ id: z.string(), passes: z.number().int(), fails: z.number().int(), errors: z.number().int(), traceRef: z.string() })),
        }),
      ),
    }),
  ),
});

export type ResultsV1 = z.infer<typeof ResultsV1Schema>;
