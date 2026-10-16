import { ConfigError } from '@mcp-evals/core';
import { readResultsFile } from '../files.js';
import { compareResults, formatComparison, type Comparison } from '../report/compare.js';

export interface CompareCommandOptions {
  base: string;
  head: string;
  /** Percentage points (default 5 in the CLI). */
  maxSuccessDrop: number;
  /** Percent (default 20 in the CLI). */
  maxContextIncrease: number;
  format: 'table' | 'markdown' | 'json';
  log?: (line: string) => void;
}

/** Exit 1 on a regression, 0 otherwise, 2 for unreadable or invalid input. */
export async function compareCommand(o: CompareCommandOptions): Promise<{ exitCode: number; comparison?: Comparison }> {
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    for (const [flag, v] of [['--max-success-drop', o.maxSuccessDrop], ['--max-context-increase', o.maxContextIncrease]] as const) {
      if (!Number.isFinite(v) || v < 0) throw new ConfigError(`${flag} must be a non-negative number, got ${v}`);
    }
    const base = await readResultsFile(o.base);
    const head = await readResultsFile(o.head);
    const comparison = compareResults(base, head, { maxSuccessDropPts: o.maxSuccessDrop, maxContextIncreasePct: o.maxContextIncrease });
    log(formatComparison(comparison, o.format));
    return { exitCode: comparison.regressions > 0 ? 1 : 0, comparison };
  } catch (e) {
    if (e instanceof ConfigError) {
      log(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    throw e;
  }
}
