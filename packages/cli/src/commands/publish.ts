import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ConfigError, isValidRunId } from '@mcp-evals/core';
import { fsReason, readResultsFile, writeFileAtomic } from '../files.js';

export interface PublishCommandOptions {
  results: string;
  traces: string;
  /** Repository data directory (default "data"). */
  dataDir: string;
  /** Also write <dataDir>/latest.json. */
  latest?: boolean;
  allowPartial?: boolean;
  log?: (line: string) => void;
  /** Environment holding the current OPENROUTER_API_KEY, whose value must not be published (default process.env). */
  env?: Record<string, string | undefined>;
}

/** Refuses text that contains an OpenRouter key; never echoes the key. */
function assertNoSecrets(label: string, text: string, apiKey: string | undefined): void {
  if (text.includes('sk-or-')) throw new ConfigError(`${label} contains an OpenRouter API key (sk-or-); refusing to publish. Remove it and re-run publish.`);
  if (apiKey && text.includes(apiKey)) {
    throw new ConfigError(`${label} contains the value of OPENROUTER_API_KEY; refusing to publish. Remove it and re-run publish.`);
  }
}

/** Spec §5.3 layout: data/runs/<runId>/results.json, data/runs/<runId>/traces.jsonl.gz, data/latest.json. */
export async function publishCommand(o: PublishCommandOptions): Promise<{ exitCode: number }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const results = await readResultsFile(o.results);
    // The run id becomes a directory name under data/runs: it must be exactly one safe segment.
    if (!isValidRunId(results.runId)) {
      throw new ConfigError(`invalid run id ${JSON.stringify(results.runId)} in ${resolve(o.results)}: use letters, digits, ".", "_" and "-" only`);
    }
    if (results.partial && !o.allowPartial) {
      throw new ConfigError(`results ${results.runId} are partial; finish them with --resume first, or pass --allow-partial`);
    }
    const tracesPath = resolve(o.traces);
    let traces: Buffer;
    try {
      traces = await readFile(tracesPath);
    } catch (e) {
      throw new ConfigError(`cannot read traces file ${tracesPath}: ${fsReason(e)}`);
    }
    const lines = traces.toString('utf8').split('\n').filter((l) => l.trim() !== '');
    lines.forEach((line, i) => {
      try {
        JSON.parse(line);
      } catch {
        throw new ConfigError(`traces file ${tracesPath}: line ${i + 1} is not JSON`);
      }
    });
    const key = (o.env ?? process.env).OPENROUTER_API_KEY?.trim();
    const apiKey = key && key.length >= 8 ? key : undefined;
    const text = `${JSON.stringify(results, null, 2)}\n`;
    assertNoSecrets(`results ${resolve(o.results)}`, `${await readFile(resolve(o.results), 'utf8')}\n${text}`, apiKey);
    const tracesText = traces.toString('utf8');
    assertNoSecrets(`traces ${tracesPath}`, tracesText, apiKey);
    if (tracesText.includes('/Users/')) {
      log(`warning: traces ${tracesPath} contain /Users/ paths (local file locations); check them before committing`);
    }
    const runs = results.suites.reduce((sum, s) => sum + s.cells.reduce((n, c) => n + c.runs, 0), 0);
    if (lines.length !== runs) {
      throw new ConfigError(`traces file has ${lines.length} line(s) but the results count ${runs} run(s); publish the traces written by the same run`);
    }
    const dataDir = resolve(o.dataDir);
    const runDir = join(dataDir, 'runs', results.runId);
    const resultsOut = join(runDir, 'results.json');
    if (existsSync(resultsOut)) throw new ConfigError(`${resultsOut} already exists; refusing to overwrite a published run`);
    await writeFileAtomic(join(runDir, 'traces.jsonl.gz'), gzipSync(traces));
    await writeFileAtomic(resultsOut, text);
    log(`published ${resultsOut} and ${join(runDir, 'traces.jsonl.gz')}`);
    if (o.latest) {
      await writeFileAtomic(join(dataDir, 'latest.json'), text);
      log(`updated ${join(dataDir, 'latest.json')}`);
    }
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}
