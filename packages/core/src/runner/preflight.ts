import { realpath } from 'node:fs/promises';
import { ConfigError } from '../errors.js';
import type { FixtureManager, Workspace } from '../fixtures/manager.js';
import { runSetup, setupEnv } from '../mcp/setup.js';
import type { CatalogModel, ModelPrice } from '../providers/openrouter.js';
import type { Results } from '../results/schema.js';
import type { Connector, McpConnection, PlannedCell, Suite } from '../types.js';
import { substituteVars } from '../util.js';

/** Fallback cost model when no measured run exists (spec §3.6). */
export const ASSUMED_PROMPT_TOKENS_PER_RUN = 25_000;
export const ASSUMED_COMPLETION_TOKENS_PER_RUN = 1_000;

export interface ServerCheck {
  suite: string;
  server: string;
  tools: number;
  version: string | null;
}

/** Starts every selected server once, in a fresh workspace after its setup, and lists its tools. */
export async function checkServers(o: { suites: Suite[]; servers?: string[]; connector: Connector; fixtures: FixtureManager }): Promise<ServerCheck[]> {
  const checks: ServerCheck[] = [];
  for (const suite of o.suites) {
    for (const [name, server] of Object.entries(suite.servers)) {
      if (o.servers && !o.servers.includes(name)) continue;
      let ws: Workspace | undefined;
      let conn: McpConnection | undefined;
      try {
        ws = await o.fixtures.createWorkspace(suite.fixture);
        const dir = await realpath(ws.dir);
        const vars = { fixture: dir };
        if (server.setup) await runSetup(substituteVars(server.setup, vars), dir, setupEnv(server.env, vars));
        conn = await o.connector(server, { cwd: dir, vars });
        const tools = await conn.listTools();
        checks.push({ suite: suite.name, server: name, tools: tools.length, version: conn.serverVersion?.() ?? null });
      } catch (e) {
        const stderr = conn?.stderr() ?? '';
        const message = e instanceof Error ? e.message : String(e);
        throw new ConfigError(`pre-flight: server "${name}" (suite ${suite.name}) failed: ${message}${stderr ? `\n${stderr.slice(-2000)}` : ''}`);
      } finally {
        await conn?.close().catch(() => {});
        await ws?.dispose().catch(() => {});
      }
    }
  }
  return checks;
}

export interface ModelEstimate {
  model: string;
  runs: number;
  usdPerRun: number;
  basis: 'measured' | 'catalog';
}

export interface CostEstimate {
  runs: number;
  usd: number;
  perModel: ModelEstimate[];
}

/** Measured cost per run (e.g. the smoke run's) for `model`, weighted by completed runs; undefined when none. */
export function measuredCostPerRun(results: Results, model: string): number | undefined {
  let usd = 0;
  let n = 0;
  for (const s of results.suites) {
    for (const c of s.cells) {
      if (c.model !== model) continue;
      const completed = Math.round(c.runs * (1 - c.errorRate));
      usd += c.costUsdPerTask * completed;
      n += completed;
    }
  }
  return n > 0 ? usd / n : undefined;
}

/** Cost of the remaining runs: measured cost per run where known, else catalog price × assumed tokens. */
export function estimateCost(o: { remaining: PlannedCell[]; prices: ReadonlyMap<string, ModelPrice | null>; measured?: Results }): CostEstimate {
  const runsByModel = new Map<string, number>();
  for (const c of o.remaining) runsByModel.set(c.model, (runsByModel.get(c.model) ?? 0) + c.runs);
  const perModel: ModelEstimate[] = [];
  for (const [model, runs] of runsByModel) {
    const measured = o.measured ? measuredCostPerRun(o.measured, model) : undefined;
    if (measured !== undefined) {
      perModel.push({ model, runs, usdPerRun: measured, basis: 'measured' });
      continue;
    }
    const price = o.prices.get(model);
    if (!price) throw new ConfigError(`no price for model "${model}" in the OpenRouter catalog; cannot estimate the cost`);
    const usdPerRun = ASSUMED_PROMPT_TOKENS_PER_RUN * price.prompt + ASSUMED_COMPLETION_TOKENS_PER_RUN * price.completion;
    perModel.push({ model, runs, usdPerRun, basis: 'catalog' });
  }
  return {
    runs: perModel.reduce((s, m) => s + m.runs, 0),
    usd: perModel.reduce((s, m) => s + m.runs * m.usdPerRun, 0),
    perModel,
  };
}

/** Everything that would make an OpenRouter run fail: unpinned models, models missing or without tools, a missing judge. */
export function catalogIssues(o: { suites: Suite[]; planned: PlannedCell[]; catalog: ReadonlyMap<string, CatalogModel> }): string[] {
  const issues: string[] = [];
  for (const suite of o.suites) {
    const models = [...new Set(o.planned.filter((p) => p.suite === suite.name).map((p) => p.model))];
    if (models.length === 0) continue;
    for (const model of models) {
      if (suite.modelPins[model] === undefined) {
        issues.push(`suite ${suite.name}: model "${model}" has no provider pin; write it as { id: ${model}, provider: <slug> }`);
      }
      const entry = o.catalog.get(model);
      if (!entry) issues.push(`suite ${suite.name}: model "${model}" is not in the OpenRouter catalog`);
      else if (!entry.supportsTools) issues.push(`suite ${suite.name}: model "${model}" does not support tool calling on OpenRouter`);
    }
    const judged = suite.tasks.some((t) => t.graders.some((g) => g.type === 'llm_judge'));
    if (judged && suite.judge && !o.catalog.has(suite.judge.id)) issues.push(`suite ${suite.name}: judge "${suite.judge.id}" is not in the OpenRouter catalog`);
  }
  return issues;
}

/** Everything that would make an OpenAI-compatible (local) run fail: a planned model or a needed judge the server does not list. Pins are not needed. */
export function servedModelIssues(o: { suites: Suite[]; planned: PlannedCell[]; served: ReadonlySet<string> }): string[] {
  const issues: string[] = [];
  const listed = () => (o.served.size > 0 ? [...o.served].sort().join(', ') : '(none)');
  for (const suite of o.suites) {
    const models = [...new Set(o.planned.filter((p) => p.suite === suite.name).map((p) => p.model))];
    if (models.length === 0) continue;
    for (const model of models) {
      if (!o.served.has(model)) issues.push(`suite ${suite.name}: model "${model}" is not listed by the server (GET /models lists: ${listed()})`);
    }
    const judged = suite.tasks.some((t) => t.graders.some((g) => g.type === 'llm_judge'));
    if (judged && suite.judge && !o.served.has(suite.judge.id)) {
      issues.push(`suite ${suite.name}: judge "${suite.judge.id}" is not listed by the server (GET /models lists: ${listed()})`);
    }
  }
  return issues;
}
