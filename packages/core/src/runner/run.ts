import { runAgentLoop, type AgentRunResult } from '../agent/loop.js';
import { ConfigError, InfraError } from '../errors.js';
import { snapshotDir, type FixtureManager, type Workspace } from '../fixtures/manager.js';
import { describeFailures, runGraders, taskPassed, toolSelectionOk } from '../graders.js';
import { runSetup } from '../mcp/setup.js';
import { convertTools } from '../tools/convert.js';
import type { Connector, GraderResult, McpConnection, ModelProvider, Outcome, RunRecord, Suite, TaskSpec } from '../types.js';
import { runKey, sleep as realSleep, substituteVars } from '../util.js';

export interface RunSuitesOptions {
  suites: Suite[];
  provider: ModelProvider;
  connector: Connector;
  fixtures: FixtureManager;
  models?: string[];
  servers?: string[];
  repeats?: number;
  budgetUsd?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: RunRecord) => void;
  now?: () => Date;
}

export interface RunSuitesOutput {
  records: RunRecord[];
  partial: boolean;
  totalCostUsd: number;
  startedAt: string;
  finishedAt: string;
}

interface RunTarget {
  suite: Suite;
  serverName: string;
  model: string;
  task: TaskSpec;
  repeat: number;
}

export async function runSuites(o: RunSuitesOptions): Promise<RunSuitesOutput> {
  validateFilters(o);
  const plan = planRuns(o);
  if (plan.length === 0) throw new ConfigError(`no runs to execute: ${emptyPlanReason(o)}`);
  // Fetch every fixture up front so a bad fixture fails before any spend (and never after earlier results).
  for (const suite of new Set(plan.map((t) => t.suite))) {
    if (suite.fixture) await o.fixtures.prepare(suite.fixture);
  }

  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const budget = o.budgetUsd ?? Number.POSITIVE_INFINITY;
  const records: RunRecord[] = [];
  let spent = 0;
  let partial = false;

  for (const target of plan) {
    if (spent >= budget) {
      partial = true;
      break;
    }
    const { record, costUsd } = await runOne(o, target, (c) => spent + c >= budget);
    spent += costUsd;
    // A budget cut-off is not a run outcome: no record, but its spend still counts.
    if (!record) {
      partial = true;
      break;
    }
    records.push(record);
    o.onRecord?.(record);
  }
  return { records, partial, totalCostUsd: spent, startedAt, finishedAt: now().toISOString() };
}

/** Repeat-major order (repeat → suite → task → server → model), so a budget cut-off hits every cell evenly. */
function planRuns(o: RunSuitesOptions): RunTarget[] {
  const suites = o.suites.map((suite) => ({
    suite,
    models: o.models ? suite.models.filter((m) => o.models!.includes(m)) : suite.models,
    servers: Object.keys(suite.servers).filter((s) => !o.servers || o.servers.includes(s)),
    repeats: o.repeats ?? suite.defaults.repeats,
  }));
  const maxRepeats = Math.max(0, ...suites.map((s) => s.repeats));
  const plan: RunTarget[] = [];
  for (let repeat = 0; repeat < maxRepeats; repeat++) {
    for (const { suite, models, servers, repeats } of suites) {
      if (repeat >= repeats) continue;
      for (const task of suite.tasks) {
        for (const serverName of servers) {
          if (task.servers && !task.servers.includes(serverName)) continue;
          for (const model of models) plan.push({ suite, serverName, model, task, repeat });
        }
      }
    }
  }
  return plan;
}

function emptyPlanReason(o: RunSuitesOptions): string {
  if (o.models && o.models.length === 0) return 'the models filter is empty';
  if (o.servers && o.servers.length === 0) return 'the servers filter is empty';
  if (o.repeats !== undefined && o.repeats < 1) return 'repeats must be at least 1';
  return 'no task in the given suites applies to the selected servers and models';
}

function validateFilters(o: RunSuitesOptions): void {
  const allModels = new Set(o.suites.flatMap((s) => s.models));
  const allServers = new Set(o.suites.flatMap((s) => Object.keys(s.servers)));
  const badModels = (o.models ?? []).filter((m) => !allModels.has(m));
  const badServers = (o.servers ?? []).filter((s) => !allServers.has(s));
  if (badModels.length) throw new ConfigError(`Unknown model(s): ${badModels.join(', ')}. Suites declare: ${[...allModels].join(', ')}`);
  if (badServers.length) throw new ConfigError(`Unknown server(s): ${badServers.join(', ')}. Suites declare: ${[...allServers].join(', ')}`);
}

interface RunOneResult {
  /** Undefined when the run was cut off by the budget. */
  record?: RunRecord;
  costUsd: number;
}

async function runOne(o: RunSuitesOptions, target: RunTarget, overBudget: (runCostUsd: number) => boolean): Promise<RunOneResult> {
  const { suite, serverName, model, task } = target;
  const server = suite.servers[serverName]!;
  const retries = o.retries ?? 3;
  const sleep = o.sleep ?? realSleep;
  let attempts = 0;
  let costUsd = 0;

  for (;;) {
    attempts++;
    let ws: Workspace | undefined;
    let conn: McpConnection | undefined;
    let result: AgentRunResult | undefined;
    let stderr = '';
    let backoffMs = 0;
    try {
      ws = await o.fixtures.createWorkspace(suite.fixture);
      const vars = { fixture: ws.dir };
      if (server.setup) await runSetup(substituteVars(server.setup, vars), ws.dir);
      conn = await o.connector(server, { cwd: ws.dir, vars });
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
        return { record: makeRecord(target, 'error', undefined, [], reason, stderr, attempts, costUsd), costUsd };
      }
      // Snapshot after setup and server start, so fs_state judges only the agent's changes.
      const snapshot = await snapshotDir(ws.dir);
      const tools = convertTools(listed);
      const priorCost = costUsd;
      result = await runAgentLoop({
        provider: o.provider,
        connection: conn,
        tools,
        model,
        prompt: task.prompt,
        maxSteps: task.maxSteps ?? suite.defaults.maxSteps,
        timeoutMs: (task.timeoutS ?? suite.defaults.timeoutS) * 1000,
        temperature: suite.defaults.temperature,
        shouldStop: (loopCost) => overBudget(priorCost + loopCost),
      });
      costUsd += result.costUsd;
      stderr = conn.stderr();
      if (result.end === 'infra_error' && result.infraError) throw result.infraError;
      if (result.end === 'budget') return { costUsd };
      const graders = await runGraders(task.graders, {
        server: serverName,
        finalAnswer: result.finalAnswer,
        events: result.events,
        steps: result.steps,
        contextTokens: result.contextTokens,
        workspace: { dir: ws.dir, snapshot },
      });
      const pass = taskPassed(graders, result.end);
      const reason = pass ? undefined : result.end === 'final_answer' ? describeFailures(graders) : result.failReason;
      return { record: makeRecord(target, pass ? 'pass' : 'fail', result, graders, reason, stderr, attempts, costUsd), costUsd };
    } catch (e) {
      try {
        stderr = conn?.stderr() ?? stderr;
      } catch {
        // ignore
      }
      if (!(e instanceof InfraError)) {
        const reason = `unexpected: ${e instanceof Error ? e.message : String(e)}`;
        return { record: makeRecord(target, 'error', result, [], reason, stderr, attempts, costUsd), costUsd };
      }
      if (e.retryable && attempts <= retries) {
        backoffMs = 500 * 2 ** (attempts - 1);
      } else {
        return { record: makeRecord(target, 'error', result, [], `${e.kind}: ${e.message}`, stderr, attempts, costUsd), costUsd };
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
): RunRecord {
  const key = runKey({ suite: target.suite.name, server: target.serverName, model: target.model, task: target.task.id, repeat: target.repeat });
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
    toolSelectionOk: outcome === 'error' ? null : toolSelectionOk(graders, result?.end ?? null),
    trace: { runKey: key, ...base, ...summary, events: result?.events ?? [], serverStderr },
  };
}
