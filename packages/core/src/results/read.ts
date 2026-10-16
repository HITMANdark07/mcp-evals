import type { z } from 'zod';
import { ConfigError } from '../errors.js';
import { isPlainObject } from '../util.js';
import { ResultsSchema, ResultsV1Schema, type Results, type ResultsV1 } from './schema.js';

/** Validates parsed results.json content and returns it as schema v2, upgrading v1 (missing fields become null/false). */
export function readResults(json: unknown): Results {
  const version = isPlainObject(json) ? json.schemaVersion : undefined;
  if (version === 2) return parse(ResultsSchema, json);
  if (version === 1) return upgradeV1(parse(ResultsV1Schema, json));
  throw new ConfigError(`unsupported results schemaVersion ${JSON.stringify(version ?? null)} (expected 1 or 2)`);
}

function parse<S extends z.ZodType>(schema: S, json: unknown): z.output<S> {
  const r = schema.safeParse(json);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
  throw new ConfigError(`invalid results: ${issues.join('; ')}`);
}

function upgradeV1(v1: ResultsV1): Results {
  return {
    ...v1,
    schemaVersion: 2,
    harnessCommit: null,
    suites: v1.suites.map((s) => ({
      ...s,
      servers: Object.fromEntries(Object.entries(s.servers).map(([name, srv]) => [name, { ...srv, args: null, setup: null, version: null }])),
      judge: null,
      cells: s.cells.map((c) => ({ ...c, plannedRuns: null, complete: false, providerPromptTokensPerTask: null, successRateWithErrors: null, invalidToolCallRate: null })),
    })),
  };
}
