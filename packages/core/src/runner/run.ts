import { realpath } from 'node:fs/promises';
import { runAgentLoop, type AgentRunResult } from '../agent/loop.js';
import { ConfigError, CostUnknownError, InfraError, OutOfCreditsError, spentUsd } from '../errors.js';
import { snapshotDir, type FixtureManager, type Workspace } from '../fixtures/manager.js';
import { describeFailures, gradersCostUsd, runGraders, taskPassed, toolSelectionOk } from '../graders.js';
import { runSetup, setupEnv } from '../mcp/setup.js';
import { convertTools } from '../tools/convert.js';
import type { Connector, GraderResult, McpConnection, ModelProvider, Outcome, PlannedCell, RunRecord, Suite, TaskSpec } from '../types.js';
import { providerBackoffMs, runKey, sleep as realSleep, substituteVars, suiteDir } from '../util.js';

export interface PlanOptions {
  suites: Suite[];
  models?: string[];
  servers?: string[];
  tasks?: string[];
  repeats?: number;
  /** runKeys a resumed run already finished: they stay in the plan but are not executed. */
  skip?: ReadonlySet<string>;
}

export interface RunSuitesOptions extends PlanOptions {
  provider: ModelProvider;
  connector: Connector;
  fixtures: FixtureManager;
  /** Cap on this invocation's spend. */
  budgetUsd?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Awaited before the next run starts (so a cache append lands first). */
  onRecord?: (r: RunRecord) => void | Promise<void>;
  now?: () => Date;
}

export type StopReason = 'budget' | 'out_of_credits' | 'cost_unknown' | 'repeated_provider_error';

/** This many consecutive error records with the same provider failReason, for one model, stop the run. */
export const REPEATED_PROVIDER_ERROR_LIMIT = 3;

export interface RunSuitesOutput {
  /** Records produced by this invocation (not the skipped ones). */
  records: RunRecord[];
  /** Runs per suite × server × model in the full plan, in plan order. */
  planned: PlannedCell[];
  partial: boolean;
  stopReason: StopReason | null;
  /** What stopped the run: the provider message, the cost-unknown reason, or "<model>: <failReason>". */
  stopDetail?: string;
  totalCostUsd: number;
  startedAt: string;
  finishedAt: string;
}

export interface PlanPreview {
  planned: PlannedCell[];
  /** planned minus the skipped runKeys. */
  remaining: PlannedCell[];
}

interface RunTarget {
  suite: Suite;
  serverName: string;
  model: string;
  task: TaskSpec;
  repeat: number;
}

/** The plan a run would execute, validated exactly like runSuites validates it. */
export function previewPlan(o: PlanOptions): PlanPreview {
  const plan = validPlan(o);
  return { planned: countPlanned(plan), remaining: countPlanned(plan.filter((t) => !o.skip?.has(keyOf(t)))) };
}

export async function runSuites(o: RunSuitesOptions): Promise<RunSuitesOutput> {
  if (o.budgetUsd !== undefined && !(o.budgetUsd >= 0)) throw new ConfigError(`budgetUsd must be a non-negative number, got ${o.budgetUsd}`);
  const plan = validPlan(o);
  const todo = plan.filter((t) => !o.skip?.has(keyOf(t)));
  // Fetch every fixture up front so a bad fixture fails before any spend (and never after earlier results).
  for (const suite of new Set(todo.map((t) => t.suite))) {
    if (suite.fixture) await o.fixtures.prepare(suite.fixture);
  }

  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const budget = o.budgetUsd ?? Number.POSITIVE_INFINITY;
  const records: RunRecord[] = [];
  let spent = 0;
  let stopReason: StopReason | null = null;
  let stopDetail: string | undefined;
  /** Per model: the last provider error failReason and how many records in a row had it. */
  const streaks = new Map<string, { reason: string; count: number }>();

  for (const target of todo) {
    if (spent >= budget) {
      stopReason = 'budget';
      break;
    }
    const out = await runOne(o, target, (c) => spent + c >= budget);
    spent += out.costUsd;
    // A budget, out-of-credits or unknown-cost cut-off is not a run outcome: no record, but its spend still counts.
    if (!out.record) {
      stopReason = out.stop ?? 'budget';
      stopDetail = out.stopDetail;
      break;
    }
    records.push(out.record);
    await o.onRecord?.(out.record);
    // The same provider error over and over (a bad request, a model the pin cannot serve) would only burn the plan.
    const r = out.record;
    if (r.outcome === 'error' && r.failReason?.startsWith('provider:')) {
      const prev = streaks.get(r.model);
      const count = prev && prev.reason === r.failReason ? prev.count + 1 : 1;
      streaks.set(r.model, { reason: r.failReason, count });
      if (count >= REPEATED_PROVIDER_ERROR_LIMIT) {
        stopReason = 'repeated_provider_error';
        stopDetail = `${r.model}: ${r.failReason}`;
        break;
      }
    } else {
      streaks.delete(r.model);
    }
  }
  return {
    records,
    planned: countPlanned(plan),
    partial: stopReason !== null,
    stopReason,
    ...(stopDetail !== undefined ? { stopDetail } : {}),
    totalCostUsd: spent,
    startedAt,
    finishedAt: now().toISOString(),
  };
}

function validPlan(o: PlanOptions): RunTarget[] {
  validateFilters(o);
  const plan = planRuns(o);
  if (plan.length === 0) throw new ConfigError(`no runs to execute: ${emptyPlanReason(o)}`);
  return plan;
}

function keyOf(t: RunTarget): string {
  return runKey({ suite: t.suite.name, server: t.serverName, model: t.model, task: t.task.id, repeat: t.repeat });
}

/** Repeat-major order (repeat → suite → task → server → model), so a budget cut-off hits every cell evenly. */
function planRuns(o: PlanOptions): RunTarget[] {
  const suites = o.suites.map((suite) => ({
    suite,
    models: o.models ? suite.models.filter((m) => o.models!.includes(m)) : suite.models,
    servers: Object.keys(suite.servers).filter((s) => !o.servers || o.servers.includes(s)),
    tasks: o.tasks ? suite.tasks.filter((t) => o.tasks!.includes(t.id)) : suite.tasks,
    repeats: o.repeats ?? suite.defaults.repeats,
  }));
  const maxRepeats = Math.max(0, ...suites.map((s) => s.repeats));
  const plan: RunTarget[] = [];
  for (let repeat = 0; repeat < maxRepeats; repeat++) {
    for (const { suite, models, servers, tasks, repeats } of suites) {
      if (repeat >= repeats) continue;
      for (const task of tasks) {
        for (const serverName of servers) {
          if (task.servers && !task.servers.includes(serverName)) continue;
          for (const model of models) plan.push({ suite, serverName, model, task, repeat });
        }
      }
    }
  }
  return plan;
}

function countPlanned(plan: RunTarget[]): PlannedCell[] {
  const cells = new Map<string, PlannedCell>();
  for (const t of plan) {
    const key = [t.suite.name, t.serverName, t.model].join('\u0000');
    const cell = cells.get(key);
    if (cell) cell.runs++;
    else cells.set(key, { suite: t.suite.name, server: t.serverName, model: t.model, runs: 1 });
  }
  return [...cells.values()];
}

function emptyPlanReason(o: PlanOptions): string {
  if (o.models && o.models.length === 0) return 'the models filter is empty';
  if (o.servers && o.servers.length === 0) return 'the servers filter is empty';
  if (o.tasks && o.tasks.length === 0) return 'the tasks filter is empty';
  if (o.repeats !== undefined && o.repeats < 1) return 'repeats must be at least 1';
  return 'no task in the given suites applies to the selected servers and models';
}

function validateFilters(o: PlanOptions): void {
  const allModels = new Set(o.suites.flatMap((s) => s.models));
  const allServers = new Set(o.suites.flatMap((s) => Object.keys(s.servers)));
  const allTasks = new Set(o.suites.flatMap((s) => s.tasks.map((t) => t.id)));
  const badModels = (o.models ?? []).filter((m) => !allModels.has(m));
  const badServers = (o.servers ?? []).filter((s) => !allServers.has(s));
  const badTasks = (o.tasks ?? []).filter((t) => !allTasks.has(t));
  if (badModels.length) throw new ConfigError(`Unknown model(s): ${badModels.join(', ')}. Suites declare: ${[...allModels].join(', ')}`);
  if (badServers.length) throw new ConfigError(`Unknown server(s): ${badServers.join(', ')}. Suites declare: ${[...allServers].join(', ')}`);
  if (badTasks.length) throw new ConfigError(`Unknown task(s): ${badTasks.join(', ')}. Suites declare: ${[...allTasks].join(', ')}`);
}

interface RunOneResult {
  /** Undefined when the run was cut off (budget, out of credits, or unknown cost). */
  record?: RunRecord;
  costUsd: number;
  stop?: StopReason;
  stopDetail?: string;
}

async function runOne(o: RunSuitesOptions, target: RunTarget, overBudget: (runCostUsd: number) => boolean): Promise<RunOneResult> {
  const { suite, serverName, model, task } = target;
  const server = suite.servers[serverName]!;
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? realSleep;
  const providerPin = suite.modelPins[model];
  let attempts = 0;
  let costUsd = 0;

  for (;;) {
    attempts++;
    let ws: Workspace | undefined;
    let conn: McpConnection | undefined;
    let result: AgentRunResult | undefined;
    let stderr = '';
    let serverVersion: string | undefined;
    let backoffMs = 0;
    try {
      ws = await o.fixtures.createWorkspace(suite.fixture);
      // The real path (macOS tmp is /var → /private/var), so the prompt and the server args name the same directory.
      const fixtureDir = await realpath(ws.dir);
      const vars = { ...task.vars, fixture: fixtureDir, suite_dir: suiteDir(suite.source) };
      if (server.setup) await runSetup(substituteVars(server.setup, vars), fixtureDir, setupEnv(server.env, vars));
      conn = await o.connector(server, { cwd: fixtureDir, vars });
      serverVersion = conn.serverVersion?.();
      let listed: Awaited<ReturnType<McpConnection['listTools']>>;
      try {
        listed = await conn.listTools();
      } catch (e) {
        if (e instanceof InfraError) throw e;
        throw new InfraError('server', `listTools failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const unknown = unknownGraderTool(task, serverName, listed.map((t) => t.name));
      if (unknown !== undefined) {
        stderr = conn.stderr();
        const reason = `grader references unknown tool "${unknown}" on server "${serverName}"`;
        return { record: makeRecord(target, 'error', undefined, [], reason, stderr, attempts, costUsd, serverVersion), costUsd };
      }
      // Snapshot after setup and server start, so fs_state judges only the agent's changes.
      const snapshot = await snapshotDir(ws.dir);
      const tools = convertTools(listed);
      const prompt = substituteVars(task.prompt, vars);
      const priorCost = costUsd;
      result = await runAgentLoop({
        provider: o.provider,
        connection: conn,
        tools,
        model,
        ...(providerPin !== undefined ? { providerPin } : {}),
        prompt,
        maxSteps: task.maxSteps ?? suite.defaults.maxSteps,
        timeoutMs: (task.timeoutS ?? suite.defaults.timeoutS) * 1000,
        temperature: suite.defaults.temperature,
        toolTimeoutMs: suite.defaults.toolTimeoutS * 1000,
        shouldStop: (loopCost) => overBudget(priorCost + loopCost),
      });
      costUsd += result.costUsd;
      stderr = conn.stderr();
      if (result.end === 'infra_error' && result.infraError) throw result.infraError;
      if (result.end === 'budget') {
        if (result.costUnknown !== undefined) return { costUsd, stop: 'cost_unknown', stopDetail: result.costUnknown };
        if (result.outOfCredits) return { costUsd, stop: 'out_of_credits', ...(result.failReason ? { stopDetail: result.failReason } : {}) };
        return { costUsd, stop: 'budget' };
      }
      const graders = await runGraders(task.graders, {
        server: serverName,
        finalAnswer: result.finalAnswer,
        events: result.events,
        steps: result.steps,
        contextTokens: result.contextTokens,
        workspace: { dir: ws.dir, snapshot },
        taskPrompt: prompt,
        ...(suite.judge ? { judge: { provider: o.provider, model: suite.judge.id, providerPin: suite.judge.provider, sleep } } : {}),
      });
      costUsd += gradersCostUsd(graders);
      const pass = taskPassed(graders, result.end);
      const reason = pass ? undefined : result.end === 'final_answer' ? describeFailures(graders) : result.failReason;
      return { record: makeRecord(target, pass ? 'pass' : 'fail', result, graders, reason, stderr, attempts, costUsd, serverVersion), costUsd };
    } catch (e) {
      try {
        stderr = conn?.stderr() ?? stderr;
      } catch {
        // ignore
      }
      // Spend the failed work still incurred (e.g. failed judge attempts); errors from the agent loop carry none.
      costUsd += spentUsd(e);
      // 402 / key limit or unknown cost (judge): stop the whole run. Spend so far counts; no record, as for a budget cut-off.
      if (e instanceof OutOfCreditsError) return { costUsd, stop: 'out_of_credits', stopDetail: e.message };
      if (e instanceof CostUnknownError) return { costUsd, stop: 'cost_unknown', stopDetail: e.reason };
      if (!(e instanceof InfraError)) {
        const reason = `unexpected: ${e instanceof Error ? e.message : String(e)}`;
        return { record: makeRecord(target, 'error', result, [], reason, stderr, attempts, costUsd, serverVersion), costUsd };
      }
      if (e.retryable && attempts <= retries) {
        // Provider trouble (rate limits, outages) needs longer to clear than a server that failed to start.
        backoffMs = e.kind === 'provider' ? providerBackoffMs(attempts) : 500 * 2 ** (attempts - 1);
      } else {
        return { record: makeRecord(target, 'error', result, [], `${e.kind}: ${e.message}`, stderr, attempts, costUsd, serverVersion), costUsd };
      }
    } finally {
      try {
        if (conn) await conn.close();
      } catch {
        // cleanup must never throw
      }
      try {
        if (ws) await ws.dispose();
      } catch {
        // cleanup must never throw
      }
    }
    await sleep(backoffMs);
  }
}

/** First tool named by an applicable tool_called / tool_args_match grader that the server does not expose. */
function unknownGraderTool(task: TaskSpec, serverName: string, available: string[]): string | undefined {
  for (const g of task.graders) {
    if (g.server !== undefined && g.server !== serverName) continue;
    if ((g.type === 'tool_called' || g.type === 'tool_args_match') && !available.includes(g.tool)) return g.tool;
  }
  return undefined;
}

function makeRecord(
  target: RunTarget,
  outcome: Outcome,
  result: AgentRunResult | undefined,
  graders: GraderResult[],
  failReason: string | undefined,
  serverStderr: string,
  attempts: number,
  costUsd: number,
  serverVersion: string | undefined,
): RunRecord {
  const key = keyOf(target);
  const base = { suite: target.suite.name, server: target.serverName, model: target.model, task: target.task.id, repeat: target.repeat };
  const summary = {
    outcome,
    end: result?.end ?? null,
    ...(failReason ? { failReason } : {}),
    graders,
    attempts,
    costUsd,
    steps: result?.steps ?? 0,
    contextTokens: result?.contextTokens ?? 0,
    latencyMs: result?.latencyMs ?? 0,
  };
  return {
    runKey: key,
    ...base,
    ...summary,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
    toolSelectionOk: outcome === 'error' ? null : toolSelectionOk(graders),
    trace: { runKey: key, ...base, ...summary, events: result?.events ?? [], serverStderr },
  };
}
