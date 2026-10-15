import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  aggregate,
  ConfigError,
  FixtureManager,
  loadMockScript,
  loadSuite,
  MockProvider,
  ResultsSchema,
  runSuites,
  stdioConnector,
  SuiteError,
  type Connector,
  type ModelProvider,
  type Results,
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
    const suites = await Promise.all(o.suites.map((p) => loadSuite(resolve(p))));
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
    if (e instanceof SuiteError || e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}

async function makeProvider(o: RunCommandOptions): Promise<ModelProvider> {
  if (o.provider !== 'mock') throw new ConfigError(`unknown provider "${o.provider}" (M1 supports: mock)`);
  if (!o.mockScript) throw new ConfigError('--mock-script is required with --provider mock');
  return new MockProvider(await loadMockScript(resolve(o.mockScript)));
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), text);
}
