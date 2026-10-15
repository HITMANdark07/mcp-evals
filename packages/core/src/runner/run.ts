import { runAgentLoop, type AgentRunResult } from '../agent/loop.js';
import { ConfigError, InfraError } from '../errors.js';
import type { FixtureManager, Workspace } from '../fixtures/manager.js';
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
  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const budget = o.budgetUsd ?? Number.POSITIVE_INFINITY;
  const records: RunRecord[] = [];
  let spent = 0;
  let partial = false;

  outer: for (const suite of o.suites) {
    if (suite.fixture) await o.fixtures.prepare(suite.fixture);
    const models = o.models ? suite.models.filter((m) => o.models!.includes(m)) : suite.models;
    const servers = Object.keys(suite.servers).filter((s) => !o.servers || o.servers.includes(s));
    const repeats = o.repeats ?? suite.defaults.repeats;
    for (const serverName of servers) {
      for (const model of models) {
        for (const task of suite.tasks) {
          if (task.servers && !task.servers.includes(serverName)) continue;
          for (let repeat = 0; repeat < repeats; repeat++) {
            if (spent >= budget) {
              partial = true;
              break outer;
            }
            const record = await runOne(o, { suite, serverName, model, task, repeat }, (c) => spent + c >= budget);
            spent += record.costUsd;
            records.push(record);
            o.onRecord?.(record);
            if (record.end === 'budget') {
              partial = true;
              break outer;
            }
          }
        }
      }
    }
  }
  return { records, partial, totalCostUsd: spent, startedAt, finishedAt: now().toISOString() };
}

function validateFilters(o: RunSuitesOptions): void {
  const allModels = new Set(o.suites.flatMap((s) => s.models));
  const allServers = new Set(o.suites.flatMap((s) => Object.keys(s.servers)));
  const badModels = (o.models ?? []).filter((m) => !allModels.has(m));
  const badServers = (o.servers ?? []).filter((s) => !allServers.has(s));
  if (badModels.length) throw new ConfigError(`Unknown model(s): ${badModels.join(', ')}. Suites declare: ${[...allModels].join(', ')}`);
  if (badServers.length) throw new ConfigError(`Unknown server(s): ${badServers.join(', ')}. Suites declare: ${[...allServers].join(', ')}`);
}

async function runOne(o: RunSuitesOptions, target: RunTarget, overBudget: (runCostUsd: number) => boolean): Promise<RunRecord> {
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
      if (result.end === 'budget') return makeRecord(target, 'error', result, [], 'budget exhausted', stderr, attempts, costUsd);
      const graders = await runGraders(task.graders, {
        server: serverName,
        finalAnswer: result.finalAnswer,
        events: result.events,
        steps: result.steps,
        contextTokens: result.contextTokens,
        workspace: ws,
      });
      const pass = taskPassed(graders, result.end);
      const reason = pass ? undefined : result.end === 'final_answer' ? describeFailures(graders) : result.failReason;
      return makeRecord(target, pass ? 'pass' : 'fail', result, graders, reason, stderr, attempts, costUsd);
    } catch (e) {
      if (!(e instanceof InfraError)) throw e;
      stderr = conn?.stderr() ?? stderr;
      if (e.retryable && attempts <= retries) {
        await sleep(500 * 2 ** (attempts - 1));
        continue;
      }
      return makeRecord(target, 'error', result, [], `${e.kind}: ${e.message}`, stderr, attempts, costUsd);
    } finally {
      if (conn) await conn.close();
      if (ws) await ws.dispose();
    }
  }
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
  return {
    runKey: key,
    ...base,
    outcome,
    end: result?.end ?? null,
    ...(failReason ? { failReason } : {}),
    graders,
    toolSelectionOk: outcome === 'error' ? null : toolSelectionOk(graders, result?.end ?? null),
    steps: result?.steps ?? 0,
    contextTokens: result?.contextTokens ?? 0,
    latencyMs: result?.latencyMs ?? 0,
    costUsd,
    attempts,
    trace: { runKey: key, ...base, events: result?.events ?? [], serverStderr },
  };
}
