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
  OPENAI_COMPATIBLE_PROVIDER,
  parseMockScript,
  previewPlan,
  ResultsSchema,
  REPEATED_PROVIDER_ERROR_LIMIT,
  RunCache,
  runSuites,
  stdioConnector,
  SuiteError,
  type Connector,
  type MockScript,
  type ModelProvider,
  type Results,
  type RunRecord,
  type RunSuitesOutput,
  type Suite,
} from '@mcp-evals/core';
import { fsReason, writeFileAtomic } from '../files.js';
import { formatTable, usd } from '../report/table.js';
import { CLI_VERSION, harnessCommit } from '../version.js';
import { openAICompatiblePreflight, openRouterPreflight } from './preflight.js';

export interface RunCommandOptions {
  suites: string[];
  /** 'openrouter' (CLI default), 'openai-compatible' (local servers such as Ollama) or 'mock'. */
  provider: string;
  /** With 'openai-compatible': the server's base URL (default: env OPENAI_COMPATIBLE_BASE_URL). */
  baseUrl?: string;
  mockScript?: string;
  models?: string[];
  servers?: string[];
  tasks?: string[];
  repeats?: number;
  /** Cap on this invocation's spend. */
  budgetUsd?: number;
  /** Continue a cached run: skip its finished runs and reuse its runId. */
  resume?: string;
  /** With --resume: re-run cached runs whose outcome was `error` instead of treating them as finished. */
  retryErrors?: boolean;
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
  /** Environment to read OPENROUTER_API_KEY, OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Test seam: point the OpenRouter client at a local fake server. */
  openRouterBaseUrl?: string;
  now?: () => Date;
  /** How this CLI was invoked (default: process.argv[0..1]); the printed resume command starts with it. */
  invocation?: string[];
}

export async function runCommand(o: RunCommandOptions): Promise<{ exitCode: number; results?: Results; runId?: string }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = o.now ?? (() => new Date());
  try {
    if (!PROVIDERS.includes(o.provider)) throw new ConfigError(`unknown provider "${o.provider}" (supported: ${PROVIDERS.join(', ')})`);
    const env = o.env ?? process.env;
    const local = o.provider === OPENAI_COMPATIBLE_PROVIDER;
    if (o.baseUrl !== undefined && !local) throw new ConfigError(`--base-url only applies with --provider ${OPENAI_COMPATIBLE_PROVIDER}`);
    const baseUrl = local ? (o.baseUrl ?? env.OPENAI_COMPATIBLE_BASE_URL)?.trim() : undefined;
    if (local && !baseUrl) {
      throw new ConfigError(
        `--provider ${OPENAI_COMPATIBLE_PROVIDER} needs the server's base URL: pass --base-url (e.g. http://localhost:11434/v1 for Ollama) or set OPENAI_COMPATIBLE_BASE_URL`,
      );
    }
    const loaded = await Promise.all(o.suites.map(readSuite));
    const suites = local ? loaded.map((s) => forServedModels(s, o.models)) : loaded;
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
    if (o.retryErrors && o.resume === undefined) throw new ConfigError('--retry-errors only applies with --resume <runId>');
    // Error records count as finished, unless --retry-errors asks to run them again.
    const skip = new Set(prior.filter((r) => !(o.retryErrors && r.outcome === 'error')).map((r) => r.runKey));
    const plan = previewPlan({ suites, ...filters, skip });
    const fixtures = new FixtureManager({ cacheDir: resolve(o.cacheDir) });
    const connector = o.connector ?? stdioConnector;
    const common = { suites, ...(o.servers ? { servers: o.servers } : {}), plan, fixtures, connector, env, log };
    let provider: ModelProvider;
    if (local) provider = await openAICompatiblePreflight({ ...common, baseUrl: baseUrl ?? '' });
    else if (o.provider === 'openrouter') {
      provider = await openRouterPreflight({
        ...common,
        ...(o.openRouterBaseUrl ? { baseUrl: o.openRouterBaseUrl } : {}),
        ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
        ...(o.yes ? { yes: true } : {}),
        ...(o.estimateFrom ? { estimateFrom: o.estimateFrom } : {}),
      });
    } else provider = await makeMockProvider(o);
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
    log(`run ${runId}: ${remaining} run(s) to execute${o.resume !== undefined ? `, ${skip.size} reused from the run cache` : ''}`);

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
    // The last record per runKey wins (a retried error is replaced). The replaced record's spend was real:
    // keep it as unrecorded spend, so the total stays right now and in every later resume.
    const merged = new Map(prior.map((r) => [r.runKey, r] as const));
    let replacedUsd = 0;
    for (const r of run.records) {
      replacedUsd += merged.get(r.runKey)?.costUsd ?? 0;
      merged.set(r.runKey, r);
    }
    const unrecordedUsd = run.totalCostUsd - run.records.reduce((s, r) => s + r.costUsd, 0) + replacedUsd;
    if (unrecordedUsd > 1e-9) await runCache.addUnrecordedSpend(unrecordedUsd);

    const records = [...merged.values()];
    const plannedTotal = run.planned.reduce((s, c) => s + c.runs, 0);
    const results = ResultsSchema.parse(
      aggregate({
        records,
        suites,
        planned: run.planned,
        providerName: provider.name,
        harnessVersion: CLI_VERSION,
        harnessCommit: harnessCommit(),
        runId,
        startedAt: runCache.manifest.createdAt,
        finishedAt: run.finishedAt,
        partial: records.length < plannedTotal,
        totalCostUsd: records.reduce((s, r) => s + r.costUsd, 0) + priorUnrecordedUsd + Math.max(0, unrecordedUsd),
      }),
    );
    // Build both payloads first, then write each atomically: traces first, so a results file always has its traces.
    const resultsText = `${JSON.stringify(results, null, 2)}\n`;
    const tracesText = records.length > 0 ? `${records.map((r) => JSON.stringify(r.trace)).join('\n')}\n` : '';
    if (o.traces && tracesText) await writeFileAtomic(o.traces, tracesText);
    await writeFileAtomic(o.out, resultsText);

    log('');
    log(formatTable(results));
    const stopped = stoppedLine(run, o);
    if (stopped) log(stopped);
    if (results.partial || run.stopReason !== null) {
      log('# Resume the remaining runs with the command below; replace <amount> with the USD cap for the resumed invocation (it caps only new spend).');
      const errors = records.filter((r) => r.outcome === 'error').length;
      if (errors > 0) log(`# Add --retry-errors to also re-run the ${errors} run(s) that ended in an error.`);
      log(resumeCommand(o, runId));
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

function stoppedLine(run: RunSuitesOutput, o: RunCommandOptions): string | undefined {
  const detail = run.stopDetail ?? 'no detail';
  switch (run.stopReason) {
    case null:
      return undefined;
    case 'budget':
      return `STOPPED: budget cap reached (--budget-usd ${usd(o.budgetUsd ?? 0)}) — run is resumable`;
    case 'out_of_credits':
      return `STOPPED: OpenRouter reports the key is out of credits or at its spend limit (${detail}). Results so far are saved — run is resumable`;
    case 'cost_unknown':
      return `STOPPED: cost could not be determined (${detail}) — run is resumable`;
    case 'repeated_provider_error': {
      const at = detail.indexOf(': ');
      const model = at === -1 ? detail : detail.slice(0, at);
      const message = at === -1 ? detail : detail.slice(at + 2);
      return `STOPPED: ${REPEATED_PROVIDER_ERROR_LIMIT} consecutive runs of ${model} ended in the same provider error (${message}) — run is resumable`;
    }
  }
}

/** A runnable command (same invocation, suites and identity flags) that resumes this run. */
function resumeCommand(o: RunCommandOptions, runId: string): string {
  const invocation = o.invocation ?? process.argv.slice(0, 2);
  const args = ['run', ...o.suites, '--resume', runId, '--provider', o.provider];
  if (o.baseUrl !== undefined) args.push('--base-url', o.baseUrl);
  if (o.mockScript !== undefined) args.push('--mock-script', o.mockScript);
  if (o.models !== undefined) args.push('--models', o.models.join(','));
  if (o.servers !== undefined) args.push('--servers', o.servers.join(','));
  if (o.tasks !== undefined) args.push('--tasks', o.tasks.join(','));
  if (o.repeats !== undefined) args.push('--repeats', String(o.repeats));
  args.push('--out', o.out);
  if (o.traces !== undefined) args.push('--traces', o.traces);
  if (o.runsDir !== undefined) args.push('--runs-dir', o.runsDir);
  args.push('--cache-dir', o.cacheDir);
  return `${[...invocation, ...args].map(shellQuote).join(' ')} --budget-usd <amount>`;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.split("'").join(`'\\''`)}'`;
}

const PROVIDERS = ['openrouter', OPENAI_COMPATIBLE_PROVIDER, 'mock'];

/**
 * A suite as an openai-compatible run sees it: `--models` names the served models to run, which need not be listed
 * in the suite (local ids such as qwen3:8b rarely are), and provider pins do not apply, so results record every
 * model (and the judge) under the provider `openai-compatible`.
 */
function forServedModels(suite: Suite, models?: string[]): Suite {
  return {
    ...suite,
    models: models ? [...new Set(models)] : suite.models,
    modelPins: {},
    ...(suite.judge ? { judge: { id: suite.judge.id, provider: OPENAI_COMPATIBLE_PROVIDER } } : {}),
  };
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
