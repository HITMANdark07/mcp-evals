import type { Results } from '@mcp-evals/core';

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const ci = ([lo, hi]: [number, number]): string => `[${Math.round(lo * 100)}–${Math.round(hi * 100)}%]`;
export const usd = (x: number): string => `$${x.toFixed(4)}`;

const HEADER = ['SUITE', 'SERVER', 'MODEL', 'RUNS', 'SUCCESS', '95% CI', 'TOOL ACC', 'CTX TOK (med)', 'STEPS', '$/TASK', 'ERRORS'];

export function formatTable(results: Results): string {
  const rows = results.suites.flatMap((s) =>
    s.cells.map((c) => [
      s.suite,
      c.server,
      c.model,
      String(c.runs),
      c.successRate === null ? '–' : pct(c.successRate),
      ci(c.successCi95),
      c.toolAccuracy === null ? '–' : pct(c.toolAccuracy),
      String(Math.round(c.contextTokensPerTask.median)),
      c.stepsPerTask.toFixed(1),
      usd(c.costUsdPerTask),
      pct(c.errorRate),
    ]),
  );
  const widths = HEADER.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  const out = [line(HEADER), ...rows.map(line)];
  if (results.partial) out.push('', 'PARTIAL: budget cap reached before all runs finished.');
  out.push('', `total cost ${usd(results.totalCostUsd)} · run ${results.runId}`);
  return out.join('\n');
}
