import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.js';
import { describeFailures, gradersCostUsd, runGraders, taskPassed, toolSelectionOk, type GradeContext } from './graders.js';
import type { GraderSpec, ModelProvider, TraceEvent } from './types.js';
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
    // Only tool graders count; an unknown-tool call is reported as invalidToolCallRate instead.
    expect(toolSelectionOk([])).toBeNull();
    expect(toolSelectionOk([r({ type: 'answer_matches', pass: false })])).toBeNull();
    expect(toolSelectionOk([r({ pass: false, skipped: true })])).toBeNull();
    expect(toolSelectionOk([r({ pass: true })])).toBe(true);
    expect(toolSelectionOk([r({ pass: true }), r({ type: 'tool_args_match', pass: false })])).toBe(false);
  });
  it('describeFailures lists failing decisive graders', () => {
    expect(describeFailures([r({ pass: false, detail: 'echo not called' }), r({ pass: false, budget: true })])).toBe(
      'tool_called: echo not called',
    );
  });
});

describe('answer_json_schema', () => {
  const spec: GraderSpec = { type: 'answer_json_schema', schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } };
  it('passes valid JSON (plain or fenced) and fails invalid or missing JSON with the reason', async () => {
    expect((await one(spec, ctx({ finalAnswer: '{"n": 3}' }))).pass).toBe(true);
    expect((await one(spec, ctx({ finalAnswer: 'Result:\n```json\n{"n": 4}\n```' }))).pass).toBe(true);
    expect(await one(spec, ctx({ finalAnswer: '{"n": "3"}' }))).toMatchObject({ pass: false, detail: '$.n: expected integer, got string' });
    expect(await one(spec, ctx({ finalAnswer: 'three' }))).toMatchObject({ pass: false, detail: expect.stringMatching(/not JSON/) });
    expect(await one(spec, ctx({ finalAnswer: null }))).toMatchObject({ pass: false, detail: 'no final answer' });
  });
});

describe('llm_judge ordering', () => {
  function judge(reply = '{"pass": true, "reason": "fine"}') {
    const calls: string[] = [];
    const provider: ModelProvider = {
      name: 'stub',
      chat: async (req) => {
        calls.push(req.model);
        return { content: reply, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0003 }, latencyMs: 1 };
      },
    };
    return { calls, cfg: { provider, model: 'j/judge' } };
  }
  const specs: GraderSpec[] = [
    { type: 'llm_judge', rubric: 'Mentions src/A.ts.' },
    { type: 'answer_contains_all', values: ['src/A.ts'], caseSensitive: false },
    { type: 'max_steps', value: 1, strict: false },
  ];

  it('runs the judge last, after the deterministic graders passed, and records its cost', async () => {
    const { calls, cfg } = judge();
    const results = await runGraders(specs, ctx({ judge: cfg, taskPrompt: 'Where?' }));
    expect(results.map((r) => r.type)).toEqual(['llm_judge', 'answer_contains_all', 'max_steps']);
    expect(results[0]).toMatchObject({ pass: true, skipped: false, costUsd: 0.0003 });
    expect(calls).toEqual(['j/judge']);
    expect(gradersCostUsd(results)).toBeCloseTo(0.0003, 12);
    expect(taskPassed(results, 'final_answer')).toBe(true);
  });

  it('does not call the judge when a deterministic grader failed or there is no final answer', async () => {
    const { calls, cfg } = judge();
    const failed = await runGraders(specs, ctx({ judge: cfg, finalAnswer: 'nothing useful' }));
    expect(failed[0]).toMatchObject({ skipped: true, detail: 'not run: a deterministic grader failed' });
    const none = await runGraders(specs, ctx({ judge: cfg, finalAnswer: null }));
    expect(none[0]).toMatchObject({ skipped: true, detail: 'not run: no final answer' });
    expect(calls).toEqual([]);
    expect(gradersCostUsd(failed)).toBe(0);
  });

  it('a failing verdict fails the task', async () => {
    const { cfg } = judge('{"pass": false, "reason": "vague"}');
    const results = await runGraders(specs, ctx({ judge: cfg }));
    expect(results[0]).toMatchObject({ pass: false, detail: 'judge fail: vague' });
    expect(taskPassed(results, 'final_answer')).toBe(false);
  });

  it('throws a ConfigError when the suite has no judge', async () => {
    await expect(runGraders(specs, ctx())).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('fs_state edge cases (M1 follow-up)', () => {
  it('counts a directory as existing and a path through a file as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'file.txt'), 'x');
    const c = ctx({ workspace: { dir, snapshot: new Map() } });
    expect((await one({ type: 'fs_state', path: 'sub', exists: true }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'sub' }, c)).pass).toBe(true);
    expect((await one({ type: 'fs_state', path: 'file.txt/inner', exists: false }, c)).pass).toBe(true);
    expect(await one({ type: 'fs_state', path: 'sub', contains: 'x' }, c)).toMatchObject({ pass: false, detail: expect.stringMatching(/is a directory/) });
  });

  it.skipIf(process.getuid?.() === 0)('treats an unreadable file as a failure, never as missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'));
    await writeFile(join(dir, 'secret.txt'), 'x');
    await chmod(join(dir, 'secret.txt'), 0o000);
    const c = ctx({ workspace: { dir, snapshot: new Map() } });
    expect(await one({ type: 'fs_state', path: 'secret.txt', exists: false }, c)).toMatchObject({ pass: false, detail: expect.stringMatching(/cannot read \(EACCES\)/) });
    await chmod(join(dir, 'secret.txt'), 0o600);
  });
});

describe('env_reward', () => {
  const conn = (reply: { text: string; isError?: boolean } | Error) => ({
    calls: [] as Array<{ name: string; args: unknown }>,
    async listTools() { return []; },
    async callTool(name: string, args: Record<string, unknown>) {
      this.calls.push({ name, args });
      if (reply instanceof Error) throw reply;
      return { text: reply.text, isError: reply.isError ?? false };
    },
    stderr: () => '',
    async close() {},
  });
  const spec: GraderSpec = { type: 'env_reward', tool: '__score', min: 1 };

  it('passes at or above min and records the reward', async () => {
    const c = conn({ text: '{"reward":1,"passed":true}' });
    const r = await one(spec, ctx({ connection: c }));
    expect(r).toMatchObject({ pass: true, value: 1 });
    expect(c.calls).toEqual([{ name: '__score', args: {} }]);
    expect(await one({ ...spec, min: 0.5 }, ctx({ connection: conn({ text: '{"reward":0.75}' }) }))).toMatchObject({ pass: true, value: 0.75 });
    expect(await one(spec, ctx({ connection: conn({ text: '{"reward":0.75}' }) }))).toMatchObject({ pass: false, value: 0.75 });
  });

  it('fails clearly without a connection, on tool errors and on malformed replies', async () => {
    expect((await one(spec)).detail).toMatch(/no server connection/);
    expect((await one(spec, ctx({ connection: conn({ text: 'boom', isError: true }) }))).detail).toMatch(/returned an error/);
    expect((await one(spec, ctx({ connection: conn({ text: 'not json' }) }))).detail).toMatch(/did not return JSON/);
    expect((await one(spec, ctx({ connection: conn({ text: '{"reward":"1"}' }) }))).detail).toMatch(/no numeric reward/);
  });

  it('lets infrastructure errors propagate so the run is retried', async () => {
    const { InfraError } = await import('./errors.js');
    await expect(one(spec, ctx({ connection: conn(new InfraError('server', 'closed', true)) }))).rejects.toThrow(/closed/);
  });
});
