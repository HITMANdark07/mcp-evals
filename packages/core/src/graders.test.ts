import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFailures, runGraders, taskPassed, toolSelectionOk, type GradeContext } from './graders.js';
import type { GraderSpec, TraceEvent } from './types.js';
import { sha256Hex } from './util.js';

const call = (tool: string, args: Record<string, unknown> | null): TraceEvent => ({
  type: 'tool_call', step: 1, t: 0, callId: 'c', tool, args, rawArgs: JSON.stringify(args),
});

function ctx(over: Partial<GradeContext> = {}): GradeContext {
  return {
    server: 'fake',
    finalAnswer: 'Found it in src/A.ts and src/b.ts',
    events: [],
    steps: 2,
    contextTokens: 100,
    workspace: { dir: tmpdir(), snapshot: new Map() },
    ...over,
  };
}

async function one(spec: GraderSpec, c: GradeContext = ctx()) {
  const [r] = await runGraders([spec], c);
  return r!;
}

describe('answer graders', () => {
  it('answer_contains_all is case-insensitive by default and lists missing values', async () => {
    expect((await one({ type: 'answer_contains_all', values: ['SRC/a.ts', 'src/b.ts'], caseSensitive: false })).pass).toBe(true);
    const r = await one({ type: 'answer_contains_all', values: ['src/a.ts', 'src/c.ts'], caseSensitive: true });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('src/a.ts');
    expect(r.detail).toContain('src/c.ts');
  });
  it('fails answer graders when there is no final answer', async () => {
    const r = await one({ type: 'answer_matches', pattern: '.*', flags: '' }, ctx({ finalAnswer: null }));
    expect(r.pass).toBe(false);
    expect(r.detail).toBe('no final answer');
  });
  it('answer_matches uses the regex and flags', async () => {
    expect((await one({ type: 'answer_matches', pattern: 'found IT', flags: 'i' })).pass).toBe(true);
    expect((await one({ type: 'answer_matches', pattern: '^nope$', flags: '' })).pass).toBe(false);
  });
});

describe('tool graders', () => {
  const events = [call('echo', { text: 'hi', opts: { loud: true, n: 2 } }), call('read_file', null)];
  it('tool_called / tool_not_called', async () => {
    expect((await one({ type: 'tool_called', tool: 'echo' }, ctx({ events }))).pass).toBe(true);
    expect((await one({ type: 'tool_called', tool: 'big' }, ctx({ events }))).pass).toBe(false);
    expect((await one({ type: 'tool_not_called', tool: 'big' }, ctx({ events }))).pass).toBe(true);
  });
  it('tool_args_match does deep partial matching and ignores calls with invalid args', async () => {
    expect((await one({ type: 'tool_args_match', tool: 'echo', args: { opts: { loud: true } } }, ctx({ events }))).pass).toBe(true);
    expect((await one({ type: 'tool_args_match', tool: 'echo', args: { opts: { loud: false } } }, ctx({ events }))).pass).toBe(false);
    expect((await one({ type: 'tool_args_match', tool: 'read_file', args: {} }, ctx({ events }))).pass).toBe(false);
  });
  it('skips graders bound to another server', async () => {
    const r = await one({ type: 'tool_called', tool: 'echo', server: 'other' }, ctx({ events }));
    expect(r).toMatchObject({ skipped: true, pass: true });
  });
});

describe('fs_state', () => {
  it('checks exists, contains, and unchanged against the snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    await writeFile(join(dir, 'a.txt'), 'hello world');
    await writeFile(join(dir, 'same.txt'), 'x');
    const snapshot = new Map([['same.txt', sha256Hex('x')], ['a.txt', sha256Hex('old')]]);
    const c = ctx({ workspace: { dir, snapshot } });
    expect((await one({ type: 'fs_state', path: 'a.txt' }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'missing.txt' }, c)).pass).toBe(false);
    expect((await one({ type: 'fs_state', path: 'missing.txt', exists: false }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'a.txt', contains: 'world' }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: './same.txt', unchanged: true }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'a.txt', unchanged: true }, c)).pass).toBe(false);
  });
});

describe('budget graders', () => {
  it('are recorded as budget unless strict', async () => {
    const r = await one({ type: 'max_steps', value: 1, strict: false });
    expect(r).toMatchObject({ pass: false, budget: true });
    expect((await one({ type: 'max_context_tokens', value: 50, strict: true })).budget).toBe(false);
  });
});

describe('pass rules', () => {
  const r = (over: Partial<import('./types.js').GraderResult>) => ({ type: 'tool_called' as const, pass: true, skipped: false, budget: false, detail: '', ...over });
  it('taskPassed requires a final answer and all non-budget graders', () => {
    expect(taskPassed([], 'final_answer')).toBe(true);
    expect(taskPassed([], 'max_steps')).toBe(false);
    expect(taskPassed([r({ pass: false, budget: true })], 'final_answer')).toBe(true);
    expect(taskPassed([r({ pass: false, skipped: true })], 'final_answer')).toBe(true);
    expect(taskPassed([r({ pass: false })], 'final_answer')).toBe(false);
  });
  it('toolSelectionOk', () => {
    expect(toolSelectionOk([], 'final_answer')).toBeNull();
    expect(toolSelectionOk([], 'invalid_tool_call')).toBe(false);
    expect(toolSelectionOk([r({ pass: true })], 'final_answer')).toBe(true);
    expect(toolSelectionOk([r({ pass: false })], 'final_answer')).toBe(false);
  });
  it('describeFailures lists failing decisive graders', () => {
    expect(describeFailures([r({ pass: false, detail: 'echo not called' }), r({ pass: false, budget: true })])).toBe(
      'tool_called: echo not called',
    );
  });
});
