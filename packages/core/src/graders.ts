import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { ConfigError } from './errors.js';
import { extractJson, validateJson } from './grading/json-schema.js';
import { runJudge, type JudgeConfig } from './grading/judge.js';
import type { GraderResult, GraderSpec, LoopEnd, TraceEvent } from './types.js';
import { isPlainObject, sha256Hex } from './util.js';

export interface GradeContext {
  server: string;
  finalAnswer: string | null;
  events: TraceEvent[];
  steps: number;
  contextTokens: number;
  workspace: { dir: string; snapshot: Map<string, string> };
  /** The prompt the agent was given; sent to llm_judge. */
  taskPrompt?: string;
  /** Judge for llm_judge graders (from the suite's judge: block). */
  judge?: JudgeConfig;
}

type JudgeSpec = Extract<GraderSpec, { type: 'llm_judge' }>;

const TOOL_TYPES = new Set<GraderResult['type']>(['tool_called', 'tool_args_match']);

export async function runGraders(specs: GraderSpec[], ctx: GradeContext): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  const judged: Array<{ index: number; spec: JudgeSpec }> = [];
  for (const [index, spec] of specs.entries()) {
    if (spec.server !== undefined && spec.server !== ctx.server) {
      results[index] = { type: spec.type, pass: true, skipped: true, budget: false, detail: `only applies to server "${spec.server}"` };
    } else if (spec.type === 'llm_judge') {
      judged.push({ index, spec });
    } else {
      results[index] = await gradeOne(spec, ctx);
    }
  }
  // llm_judge runs last and only when it can still matter (saves cost).
  const answer = ctx.finalAnswer;
  const blocked =
    answer === null
      ? 'no final answer'
      : results.some((r) => !r.skipped && !r.budget && !r.pass)
        ? 'a deterministic grader failed'
        : undefined;
  for (const { index, spec } of judged) {
    results[index] =
      blocked !== undefined || answer === null
        ? { type: 'llm_judge', pass: false, skipped: true, budget: false, detail: `not run: ${blocked ?? 'no final answer'}` }
        : await judgeOne(spec, ctx, answer);
  }
  return results;
}

/** Spend of model-graded checks, added to the run's cost. */
export function gradersCostUsd(results: GraderResult[]): number {
  return results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
}

export function taskPassed(results: GraderResult[], end: LoopEnd | null): boolean {
  if (end !== 'final_answer') return false;
  return results.filter((r) => !r.skipped && !r.budget).every((r) => r.pass);
}

/**
 * Whether the run's tool graders passed; null when the task has none. An invalid tool call (`end: invalid_tool_call`)
 * fails the run and is reported separately as `invalidToolCallRate`, so it does not count here on its own.
 */
export function toolSelectionOk(results: GraderResult[]): boolean | null {
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

async function judgeOne(spec: JudgeSpec, ctx: GradeContext, answer: string): Promise<GraderResult> {
  if (!ctx.judge) throw new ConfigError('llm_judge needs a judge model: add a judge: block to the suite');
  const v = await runJudge(ctx.judge, {
    taskPrompt: ctx.taskPrompt ?? '',
    finalAnswer: answer,
    rubric: spec.rubric,
    ...(spec.passThreshold !== undefined ? { passThreshold: spec.passThreshold } : {}),
  });
  return { type: 'llm_judge', pass: v.pass, skipped: false, budget: false, detail: v.detail, costUsd: v.costUsd };
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
    case 'answer_json_schema': {
      if (ctx.finalAnswer === null) return result(spec, false, 'no final answer');
      const parsed = extractJson(ctx.finalAnswer);
      if (!parsed.ok) return result(spec, false, parsed.error);
      const errors = validateJson(parsed.value, spec.schema);
      return result(spec, errors.length === 0, errors.length ? errors.slice(0, 5).join('; ') : 'valid JSON matching the schema');
    }
    case 'llm_judge':
      throw new Error('llm_judge is graded by runGraders, after the deterministic graders');
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
      const full = join(ctx.workspace.dir, rel);
      let kind: 'missing' | 'file' | 'dir' | 'other' = 'missing';
      let buf: Buffer | null = null;
      try {
        const st = await stat(full);
        kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
        if (kind === 'file') buf = await readFile(full);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Only "not there" counts as missing; anything else (EACCES, EIO, …) fails instead of silently passing.
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return result(spec, false, `${rel}: cannot read (${code ?? 'unknown error'})`);
        kind = 'missing';
        buf = null;
      }
      const exists = kind !== 'missing';
      const failures: string[] = [];
      const asserted = spec.exists !== undefined || spec.contains !== undefined || spec.unchanged !== undefined;
      if (!asserted && !exists) failures.push('expected file to exist');
      if (spec.exists !== undefined && exists !== spec.exists) failures.push(`expected exists=${spec.exists}`);
      if (spec.contains !== undefined && !(buf !== null && buf.toString('utf8').includes(spec.contains))) {
        failures.push(kind === 'dir' ? 'is a directory, cannot check contains' : `does not contain ${JSON.stringify(spec.contains)}`);
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
