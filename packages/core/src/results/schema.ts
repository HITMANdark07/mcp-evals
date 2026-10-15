import { z } from 'zod';

export const ResultsSchema = z.object({
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
      models: z.array(z.object({ id: z.string(), provider: z.string() })),
      cells: z.array(
        z.object({
          server: z.string(),
          model: z.string(),
          runs: z.number().int().nonnegative(),
          successRate: z.number().min(0).max(1),
          successCi95: z.tuple([z.number(), z.number()]),
          toolAccuracy: z.number().min(0).max(1).nullable(),
          contextTokensPerTask: z.object({ mean: z.number(), median: z.number() }),
          stepsPerTask: z.number(),
          latencyMsP50: z.number(),
          costUsdPerTask: z.number(),
          errorRate: z.number().min(0).max(1),
          tasks: z.array(
            z.object({
              id: z.string(),
              passes: z.number().int(),
              fails: z.number().int(),
              errors: z.number().int(),
              traceRef: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});

export type Results = z.infer<typeof ResultsSchema>;
