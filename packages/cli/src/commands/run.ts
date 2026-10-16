import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  aggregate,
  ConfigError,
  DEFAULT_RUNS_DIR,
  FixtureManager,
  identityOf,
  InfraError,
  loadSuite,
  MockProvider,
  parseMockScript,
  previewPlan,
  ResultsSchema,
  RunCache,
  runSuites,
  stdioConnector,
  SuiteError,
  type Connector,
  type MockScript,
  type ModelProvider,
  type Results,
  type RunRecord,
  type Suite,
} from '@mcp-evals/core';
import { fsReason, writeFileAtomic } from '../files.js';
import { formatTable } from '../report/table.js';
import { CLI_VERSION } from '../version.js';
import { openRouterPreflight } from './preflight.js';

export interface RunCommandOptions {
  suites: string[];
  /** 'openrouter' (CLI default) or 'mock'. */
  provider: string;
  mockScript?: string;
  models?: string[];
  servers?: string[];
  tasks?: string[];
  repeats?: number;
  /** Cap on this invocation's spend. */
  budgetUsd?: number;
  /** Continue a cached run: skip its finished runs and reuse its runId. */
  resume?: string;
  /** Start even if the pre-flight estimate exceeds the budget. */
  yes?: boolean;
  /** results.json whose measured cost per run drives the estimate (e.g. the smoke run). */
  estimateFrom?: string;
  out: string;
  traces?: string;
  cacheDir: string;
  runsDir?: string;
  retries?: number;
  connector?: Connector;
  log?: (line: string) => void;
  /** Environment to read OPENROUTER_API_KEY from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Test seam: point the OpenRouter client at a local fake server. */
  openRouterBaseUrl?: string;
  now?: () => Date;
}

export async function runCommand(o: RunCommandOptions): Promise<{ exitCode: number; results?: Results; runId?: string }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = o.now ?? (() => new Date());
  try {
    if (o.provider !== 'openrouter' && o.provider !== 'mock') throw new ConfigError(`unknown provider "${o.provider}" (supported: openrouter, mock)`);
    const suites = await Promise.all(o.suites.map(readSuite));
    const filters = {
      ...(o.models ? { models: o.models } : {}),
      ...(o.servers ? { servers: o.servers } : {}),
      ...(o.tasks ? { tasks: o.tasks } : {}),
      ...(o.repeats !== undefined ? { repeats: o.repeats } : {}),
    };
    const identity = identityOf({ provider: o.provider, suites, ...filters });
    const runsDir = resolve(o.runsDir ?? DEFAULT_RUNS_DIR);
    let cache: RunCache | undefined;
    let prior: RunRecord[] = [];
    if (o.resume !== undefined) {
      cache = await RunCache.open(runsDir, o.resume);
      cache.assertCompatible(identity);
      prior = await cache.records();
    }
    const skip = new Set(prior.map((r) => r.runKey));
    const plan = previewPlan({ suites, ...filters, skip });
    const fixtures = new FixtureManager({ cacheDir: resolve(o.cacheDir) });
    const connector = o.connector ?? stdioConnector;
    const provider: ModelProvider =
      o.provider === 'openrouter'
        ? await openRouterPreflight({
            suites,
            ...(o.servers ? { servers: o.servers } : {}),
            plan,
            fixtures,
            connector,
            env: o.env ?? process.env,
            ...(o.openRouterBaseUrl ? { baseUrl: o.openRouterBaseUrl } : {}),
            ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
            ...(o.yes ? { yes: true } : {}),
            ...(o.estimateFrom ? { estimateFrom: o.estimateFrom } : {}),
            log,
          })
        : await makeMockProvider(o);
    // A bad fixture must fail before the run cache exists and before any spend.
    for (const suite of suites) {
      if (suite.fixture && plan.remaining.some((c) => c.suite === suite.name)) await fixtures.prepare(suite.fixture);
    }
    if (!cache) {
      const createdAt = now().toISOString();
      const runId = `${createdAt.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
      cache = await RunCache.create(runsDir, { runId, createdAt, harnessVersion: CLI_VERSION, identity });
    }
    const runCache = cache;
    const runId = runCache.manifest.runId;
    const priorUnrecordedUsd = runCache.manifest.unrecordedSpendUsd;
    const remaining = plan.remaining.reduce((s, c) => s + c.runs, 0);
    log(`run ${runId}: ${remaining} run(s) to execute${prior.length > 0 ? `, ${prior.length} reused from the run cache` : ''}`);

    const run = await runSuites({
      suites,
      provider,
      connector,
      fixtures,
      ...filters,
      skip,
      ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
      ...(o.retries !== undefined ? { retries: o.retries } : {}),
      onRecord: async (r) => {
        await runCache.append(r);
        log(`${r.outcome.padEnd(5)} ${r.suite}/${r.server}/${r.model}/${r.task}#${r.repeat}${r.failReason ? ` — ${r.failReason}` : ''}`);
      },
    });
    const unrecordedUsd = run.totalCostUsd - run.records.reduce((s, r) => s + r.costUsd, 0);
    if (unrecordedUsd > 1e-9) await runCache.addUnrecordedSpend(unrecordedUsd);

    const records = [...prior, ...run.records];
    const plannedTotal = run.planned.reduce((s, c) => s + c.runs, 0);
    const results = ResultsSchema.parse(
      aggregate({
        records,
        suites,
        planned: run.planned,
        providerName: provider.name,
        harnessVersion: CLI_VERSION,
        runId,
        startedAt: runCache.manifest.createdAt,
        finishedAt: run.finishedAt,
        partial: records.length < plannedTotal,
        totalCostUsd: prior.reduce((s, r) => s + r.costUsd, 0) + priorUnrecordedUsd + run.totalCostUsd,
      }),
    );
    // Build both payloads first, then write each atomically: traces first, so a results file always has its traces.
    const resultsText = `${JSON.stringify(results, null, 2)}\n`;
    const tracesText = records.length > 0 ? `${records.map((r) => JSON.stringify(r.trace)).join('\n')}\n` : '';
    if (o.traces && tracesText) await writeFileAtomic(o.traces, tracesText);
    await writeFileAtomic(o.out, resultsText);

    log('');
    log(formatTable(results));
    if (run.stopReason === 'out_of_credits') log('STOPPED: OpenRouter reports the key is out of credits (HTTP 402). Results so far are saved.');
    if (results.partial) {
      log(`Resume the remaining runs with the same suites and filters: mcp-evals run ${o.suites.join(' ')} --resume ${runId} --budget-usd <n>`);
    }
    return { exitCode: 0, results, runId };
  } catch (e) {
    // User errors (bad input, failed pre-flight, unfetchable fixture) are all detected before any run.
    if (e instanceof SuiteError || e instanceof ConfigError || (e instanceof InfraError && e.kind === 'fixture')) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

async function makeMockProvider(o: RunCommandOptions): Promise<ModelProvider> {
  if (!o.mockScript) throw new ConfigError('--mock-script is required with --provider mock');
  return new MockProvider(await readMockScript(resolve(o.mockScript)));
}

async function readSuite(path: string): Promise<Suite> {
  const abs = resolve(path);
  try {
    return await loadSuite(abs);
  } catch (e) {
    if (e instanceof SuiteError) throw e;
    throw new ConfigError(`cannot read suite file ${abs}: ${fsReason(e)}`);
  }
}

async function readMockScript(path: string): Promise<MockScript> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read mock script ${path}: ${fsReason(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid mock script ${path}: ${(e as Error).message}`);
  }
  try {
    return parseMockScript(json);
  } catch (e) {
    throw new ConfigError(`invalid mock script ${path}: ${issuesOf(e)}`);
  }
}

function issuesOf(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (!Array.isArray(issues)) return e instanceof Error ? e.message : String(e);
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}
