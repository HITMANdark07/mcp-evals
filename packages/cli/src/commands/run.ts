import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  aggregate,
  ConfigError,
  FixtureManager,
  InfraError,
  loadSuite,
  MockProvider,
  parseMockScript,
  ResultsSchema,
  runSuites,
  stdioConnector,
  SuiteError,
  type Connector,
  type MockScript,
  type ModelProvider,
  type Results,
  type Suite,
} from '@mcp-evals/core';
import { formatTable } from '../report/table.js';
import { CLI_VERSION } from '../version.js';

export interface RunCommandOptions {
  suites: string[];
  provider: string;
  mockScript?: string;
  models?: string[];
  servers?: string[];
  repeats?: number;
  budgetUsd?: number;
  out: string;
  traces?: string;
  cacheDir: string;
  retries?: number;
  connector?: Connector;
  log?: (line: string) => void;
}

export async function runCommand(o: RunCommandOptions): Promise<{ exitCode: number; results?: Results }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const provider = await makeProvider(o);
    const suites = await Promise.all(o.suites.map(readSuite));
    const run = await runSuites({
      suites,
      provider,
      connector: o.connector ?? stdioConnector,
      fixtures: new FixtureManager({ cacheDir: resolve(o.cacheDir) }),
      ...(o.models ? { models: o.models } : {}),
      ...(o.servers ? { servers: o.servers } : {}),
      ...(o.repeats !== undefined ? { repeats: o.repeats } : {}),
      ...(o.budgetUsd !== undefined ? { budgetUsd: o.budgetUsd } : {}),
      ...(o.retries !== undefined ? { retries: o.retries } : {}),
      onRecord: (r) =>
        log(`${r.outcome.padEnd(5)} ${r.suite}/${r.server}/${r.model}/${r.task}#${r.repeat}${r.failReason ? ` — ${r.failReason}` : ''}`),
    });
    const results = ResultsSchema.parse(
      aggregate({
        records: run.records,
        suites,
        providerName: provider.name,
        harnessVersion: CLI_VERSION,
        runId: `${run.startedAt.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        partial: run.partial,
        totalCostUsd: run.totalCostUsd,
      }),
    );
    await writeText(o.out, `${JSON.stringify(results, null, 2)}\n`);
    if (o.traces) await writeText(o.traces, run.records.map((r) => JSON.stringify(r.trace)).join('\n') + '\n');
    log('');
    log(formatTable(results));
    return { exitCode: 0, results };
  } catch (e) {
    // User errors (bad input, unfetchable fixture) are all detected before any run, so nothing is written.
    if (e instanceof SuiteError || e instanceof ConfigError || (e instanceof InfraError && e.kind === 'fixture')) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

async function makeProvider(o: RunCommandOptions): Promise<ModelProvider> {
  if (o.provider !== 'mock') throw new ConfigError(`unknown provider "${o.provider}" (M1 supports: mock)`);
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

function fsReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EACCES') return 'permission denied';
  if (code === 'EISDIR') return 'is a directory';
  return e instanceof Error ? e.message : String(e);
}

function issuesOf(e: unknown): string {
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (!Array.isArray(issues)) return e instanceof Error ? e.message : String(e);
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), text);
}
