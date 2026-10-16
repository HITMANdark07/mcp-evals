import type { Results } from '@mcp-evals/core';
import { alignColumns, pct } from './table.js';

export interface CompareThresholds {
  /** Percentage points. */
  maxSuccessDropPts: number;
  /** Percent of the base median context tokens. */
  maxContextIncreasePct: number;
}

export type CellStatus = 'ok' | 'regression' | 'incomplete' | 'missing_in_base' | 'missing_in_head';

export interface CellSide {
  successRate: number | null;
  contextTokensMedian: number;
  runs: number;
  plannedRuns: number | null;
  complete: boolean;
}

export interface CellComparison {
  suite: string;
  server: string;
  model: string;
  status: CellStatus;
  base: CellSide | null;
  head: CellSide | null;
  successDeltaPts: number | null;
  contextChangePct: number | null;
  reasons: string[];
}

export interface Comparison {
  thresholds: CompareThresholds;
  regressions: number;
  cells: CellComparison[];
}

type Cell = Results['suites'][number]['cells'][number];
interface Located {
  suite: string;
  cell: Cell;
}

/** Rounds away float noise, so a drop exactly at the threshold is not a regression. */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const keyOf = (suite: string, c: Cell): string => [suite, c.server, c.model].join('\u0000');
/** Unknown completeness (results upgraded from v1) is not treated as incomplete. */
const incomplete = (s: CellSide): boolean => s.plannedRuns !== null && !s.complete;

function index(r: Results): Map<string, Located> {
  const m = new Map<string, Located>();
  for (const s of r.suites) for (const c of s.cells) m.set(keyOf(s.suite, c), { suite: s.suite, cell: c });
  return m;
}

function side(c: Cell): CellSide {
  return { successRate: c.successRate, contextTokensMedian: c.contextTokensPerTask.median, runs: c.runs, plannedRuns: c.plannedRuns, complete: c.complete };
}

export function compareResults(base: Results, head: Results, t: CompareThresholds): Comparison {
  const b = index(base);
  const h = index(head);
  const keys = [...h.keys(), ...[...b.keys()].filter((k) => !h.has(k))];
  const cells = keys.map((k) => compareCell(b.get(k), h.get(k), t));
  return { thresholds: t, regressions: cells.filter((c) => c.status === 'regression').length, cells };
}

function compareCell(b: Located | undefined, h: Located | undefined, t: CompareThresholds): CellComparison {
  const where = (h ?? b)!;
  const base = b ? side(b.cell) : null;
  const head = h ? side(h.cell) : null;
  const successDeltaPts =
    base?.successRate != null && head?.successRate != null ? round6((head.successRate - base.successRate) * 100) : null;
  const contextChangePct =
    base && head && base.contextTokensMedian > 0
      ? round6(((head.contextTokensMedian - base.contextTokensMedian) / base.contextTokensMedian) * 100)
      : null;
  const common = { suite: where.suite, server: where.cell.server, model: where.cell.model, base, head, successDeltaPts, contextChangePct };
  if (!base) return { ...common, status: 'missing_in_base', reasons: ['cell not in base results'] };
  if (!head) return { ...common, status: 'missing_in_head', reasons: ['cell not in head results'] };
  if (incomplete(base) || incomplete(head)) {
    const reasons = (
      [
        ['base', base],
        ['head', head],
      ] as const
    ).flatMap(([label, s]) => (incomplete(s) ? [`${label} incomplete (${s.runs}/${s.plannedRuns} runs)`] : []));
    return { ...common, status: 'incomplete', reasons };
  }
  const reasons: string[] = [];
  if (successDeltaPts !== null && -successDeltaPts > t.maxSuccessDropPts) {
    reasons.push(`success dropped ${(-successDeltaPts).toFixed(1)} pts (max ${t.maxSuccessDropPts})`);
  }
  if (contextChangePct !== null && contextChangePct > t.maxContextIncreasePct) {
    reasons.push(`context tokens rose ${contextChangePct.toFixed(1)}% (max ${t.maxContextIncreasePct}%)`);
  }
  return { ...common, status: reasons.length > 0 ? 'regression' : 'ok', reasons };
}

const rate = (s: CellSide | null): string => (s === null ? '–' : s.successRate === null ? 'n/a' : pct(s.successRate));
const ctx = (s: CellSide | null): string => (s === null ? '–' : String(Math.round(s.contextTokensMedian)));
const signed = (x: number): string => `${x > 0 ? '+' : ''}${x.toFixed(1)}`;
const HEADER = ['SUITE', 'SERVER', 'MODEL', 'STATUS', 'SUCCESS', 'Δ PTS', 'CTX TOK (med)', 'Δ CTX', 'NOTES'];

export function formatComparison(c: Comparison, format: 'table' | 'markdown' | 'json'): string {
  if (format === 'json') return JSON.stringify(c, null, 2);
  const rows = c.cells.map((x) => [
    x.suite,
    x.server,
    x.model,
    x.status === 'regression' ? 'REGRESSION' : x.status,
    `${rate(x.base)} → ${rate(x.head)}`,
    x.successDeltaPts === null ? '–' : signed(x.successDeltaPts),
    `${ctx(x.base)} → ${ctx(x.head)}`,
    x.contextChangePct === null ? '–' : `${signed(x.contextChangePct)}%`,
    x.reasons.join('; '),
  ]);
  const summary = `${c.regressions} regression(s) in ${c.cells.length} cell(s) · max success drop ${c.thresholds.maxSuccessDropPts} pts · max context increase ${c.thresholds.maxContextIncreasePct}%`;
  if (format === 'markdown') {
    const esc = (s: string) => s.replace(/\|/g, '\\|');
    return [`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`), '', summary].join('\n');
  }
  return [alignColumns([HEADER, ...rows]), '', summary].join('\n');
}
