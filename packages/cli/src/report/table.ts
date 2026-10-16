import type { Results } from '@mcp-evals/core';

type Cell = Results['suites'][number]['cells'][number];

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const ci = ([lo, hi]: [number, number]): string => `[${Math.round(lo * 100)}–${Math.round(hi * 100)}%]`;
export const usd = (x: number): string => `$${x.toFixed(4)}`;
/** "runs/planned", or just "runs" for results upgraded from v1. */
export const runsText = (c: Cell): string => (c.plannedRuns === null ? String(c.runs) : `${c.runs}/${c.plannedRuns}`);
export const isIncomplete = (c: Cell): boolean => c.plannedRuns !== null && !c.complete;

export function alignColumns(rows: string[][]): string {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((cells) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n');
}

const HEADER = ['SUITE', 'SERVER', 'MODEL', 'RUNS', 'SUCCESS', 'SUCCESS w/ERR', '95% CI', 'TOOL ACC', 'BAD TOOL', 'CTX TOK (med)', 'STEPS', '$/TASK', 'ERRORS'];

export function formatTable(results: Results): string {
  const rows = results.suites.flatMap((s) =>
    s.cells.map((c) => [
      s.suite,
      c.server,
      c.model,
      runsText(c),
      c.successRate === null ? '–' : pct(c.successRate),
      c.successRateWithErrors === null ? '–' : pct(c.successRateWithErrors),
      ci(c.successCi95),
      c.toolAccuracy === null ? '–' : pct(c.toolAccuracy),
      c.invalidToolCallRate === null ? '–' : pct(c.invalidToolCallRate),
      String(Math.round(c.contextTokensPerTask.median)),
      c.stepsPerTask.toFixed(1),
      usd(c.costUsdPerTask),
      pct(c.errorRate),
    ]),
  );
  const out = [alignColumns([HEADER, ...rows])];
  const notices: string[] = [];
  if (results.partial) notices.push('PARTIAL: the run stopped (budget cap, out of credits, unknown cost or repeated provider errors) before every planned run finished.');
  const incomplete = results.suites.flatMap((s) => s.cells).filter(isIncomplete).length;
  if (incomplete > 0) notices.push(`INCOMPLETE: ${incomplete} cell(s) did not finish every planned run; do not compare them as if complete.`);
  if (notices.length > 0) out.push('', ...notices);
  out.push('', `total cost ${usd(results.totalCostUsd)} · run ${results.runId}`);
  return out.join('\n');
}
