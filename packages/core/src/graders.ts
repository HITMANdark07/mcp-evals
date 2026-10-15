import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { GraderResult, GraderSpec, LoopEnd, TraceEvent } from './types.js';
import { isPlainObject, sha256Hex } from './util.js';

export interface GradeContext {
  server: string;
  finalAnswer: string | null;
  events: TraceEvent[];
  steps: number;
  contextTokens: number;
  workspace: { dir: string; snapshot: Map<string, string> };
}

const TOOL_TYPES = new Set<GraderResult['type']>(['tool_called', 'tool_args_match']);

export async function runGraders(specs: GraderSpec[], ctx: GradeContext): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const spec of specs) {
    if (spec.server !== undefined && spec.server !== ctx.server) {
      results.push({ type: spec.type, pass: true, skipped: true, budget: false, detail: `only applies to server "${spec.server}"` });
      continue;
    }
    results.push(await gradeOne(spec, ctx));
  }
  return results;
}

export function taskPassed(results: GraderResult[], end: LoopEnd | null): boolean {
  if (end !== 'final_answer') return false;
  return results.filter((r) => !r.skipped && !r.budget).every((r) => r.pass);
}

export function toolSelectionOk(results: GraderResult[], end: LoopEnd | null): boolean | null {
  if (end === 'invalid_tool_call') return false;
  const tool = results.filter((r) => !r.skipped && TOOL_TYPES.has(r.type));
  if (tool.length === 0) return null;
  return tool.every((r) => r.pass);
}

export function describeFailures(results: GraderResult[]): string {
  return results
    .filter((r) => !r.skipped && !r.budget && !r.pass)
    .map((r) => `${r.type}: ${r.detail}`)
    .join('; ');
}

function result(spec: GraderSpec, pass: boolean, detail: string): GraderResult {
  const budget = (spec.type === 'max_steps' || spec.type === 'max_context_tokens') && !spec.strict;
  return { type: spec.type, pass, skipped: false, budget, detail };
}

function toolCalls(events: TraceEvent[]) {
  return events.filter((e): e is Extract<TraceEvent, { type: 'tool_call' }> => e.type === 'tool_call');
}

async function gradeOne(spec: GraderSpec, ctx: GradeContext): Promise<GraderResult> {
  switch (spec.type) {
    case 'answer_contains_all': {
      if (ctx.finalAnswer === null) return result(spec, false, 'no final answer');
      const norm = (s: string) => (spec.caseSensitive ? s : s.toLowerCase());
      const hay = norm(ctx.finalAnswer);
      const missing = spec.values.filter((v) => !hay.includes(norm(v)));
      return result(spec, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'all values present');
    }
    case 'answer_matches': {
      if (ctx.finalAnswer === null) return result(spec, false, 'no final answer');
      const ok = new RegExp(spec.pattern, spec.flags).test(ctx.finalAnswer);
      return result(spec, ok, ok ? `matches /${spec.pattern}/` : `does not match /${spec.pattern}/`);
    }
    case 'tool_called': {
      const n = toolCalls(ctx.events).filter((c) => c.tool === spec.tool).length;
      return result(spec, n > 0, n > 0 ? `${spec.tool} called ${n} time(s)` : `${spec.tool} not called`);
    }
    case 'tool_not_called': {
      const n = toolCalls(ctx.events).filter((c) => c.tool === spec.tool).length;
      return result(spec, n === 0, n === 0 ? `${spec.tool} not called` : `${spec.tool} called ${n} time(s)`);
    }
    case 'tool_args_match': {
      const ok = toolCalls(ctx.events).some((c) => c.tool === spec.tool && c.args !== null && partialMatch(spec.args, c.args));
      return result(spec, ok, ok ? `${spec.tool} called with matching args` : `no ${spec.tool} call with matching args`);
    }
    case 'fs_state': {
      const rel = posix.normalize(spec.path.split('\\').join('/'));
      const buf = await readFile(join(ctx.workspace.dir, rel)).catch(() => null);
      const failures: string[] = [];
      const asserted = spec.exists !== undefined || spec.contains !== undefined || spec.unchanged !== undefined;
      if (!asserted && buf === null) failures.push('expected file to exist');
      if (spec.exists !== undefined && (buf !== null) !== spec.exists) failures.push(`expected exists=${spec.exists}`);
      if (spec.contains !== undefined && !(buf !== null && buf.toString('utf8').includes(spec.contains))) {
        failures.push(`does not contain ${JSON.stringify(spec.contains)}`);
      }
      if (spec.unchanged) {
        const before = ctx.workspace.snapshot.get(rel);
        const after = buf === null ? undefined : sha256Hex(buf);
        if (before !== after) failures.push('file changed');
      }
      return result(spec, failures.length === 0, failures.length ? `${rel}: ${failures.join(', ')}` : `${rel}: ok`);
    }
    case 'max_steps':
      return result(spec, ctx.steps <= spec.value, `${ctx.steps} steps (limit ${spec.value})`);
    case 'max_context_tokens':
      return result(spec, ctx.contextTokens <= spec.value, `${ctx.contextTokens} context tokens (limit ${spec.value})`);
  }
}

function partialMatch(expected: unknown, actual: unknown): boolean {
  if (isPlainObject(expected)) {
    return isPlainObject(actual) && Object.entries(expected).every(([k, v]) => partialMatch(v, actual[k]));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => partialMatch(v, actual[i]));
  }
  return Object.is(expected, actual);
}
