import { ConfigError } from '@mcp-evals/core';
import { readResultsFile } from '../files.js';
import { formatMarkdown } from '../report/markdown.js';
import { formatTable } from '../report/table.js';

export interface ReportCommandOptions {
  results: string;
  format: 'table' | 'markdown';
  log?: (line: string) => void;
}

export async function reportCommand(o: ReportCommandOptions): Promise<{ exitCode: number }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    const results = await readResultsFile(o.results);
    log(o.format === 'markdown' ? formatMarkdown(results) : formatTable(results));
    return { exitCode: 0 };
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}
