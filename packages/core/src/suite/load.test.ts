import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSuite, parseSuite, SuiteError } from './load.js';

interface Parts {
  fixture?: string;
  servers?: string;
  models?: string;
  tasks?: string;
}

function yaml(p: Parts = {}): string {
  return [
    'suite: demo',
    'version: 1',
    p.fixture ?? '',
    p.servers ?? 'servers:\n  fake: { command: node, args: ["server.mjs"] }',
    p.models ?? 'models: [mock/model-a, mock/model-b]',
    p.tasks ??
      [
        'tasks:',
        '  - id: echo',
        '    prompt: "Say hi using echo"',
        '    max_steps: 4',
        '    graders:',
        '      - { type: answer_contains_all, values: [hi] }',
        '      - { type: max_steps, value: 3 }',
      ].join('\n'),
  ].join('\n');
}

function issuesOf(text: string): string {
  try {
    parseSuite(text, 't');
  } catch (e) {
    if (e instanceof SuiteError) return e.issues.join('\n');
    throw e;
  }
  throw new Error('expected SuiteError');
}

const task = (graders: string, extra = '') =>
  `tasks:\n  - id: t1\n    prompt: p${extra}\n    graders:\n${graders}`;

describe('parseSuite', () => {
  it('parses a valid suite, applies defaults, and maps to camelCase', () => {
    const s = parseSuite(yaml(), 'demo.yaml');
    expect(s.name).toBe('demo');
    expect(s.source).toBe('demo.yaml');
    expect(s.defaults).toEqual({ repeats: 3, maxSteps: 12, timeoutS: 120, temperature: 0, toolTimeoutS: 60 });
    expect(s.servers.fake).toEqual({ command: 'node', args: ['server.mjs'], env: {}, headers: {} });
    expect(s.tasks[0]!.maxSteps).toBe(4);
    expect(s.tasks[0]!.graders).toEqual([
      { type: 'answer_contains_all', values: ['hi'], caseSensitive: false },
      { type: 'max_steps', value: 3, strict: false },
    ]);
    expect(s.fixture).toBeUndefined();
  });

  it('accepts a pinned fixture and {fixture} in server args', () => {
    const s = parseSuite(
      yaml({
        fixture: 'fixture: { git: "https://example.com/r.git", ref: "0123abcd" }',
        servers: 'servers:\n  fs: { command: npx, args: ["srv", "{fixture}"] }',
      }),
    );
    expect(s.fixture).toEqual({ git: 'https://example.com/r.git', ref: '0123abcd' });
  });

  it('rejects YAML syntax errors', () => {
    expect(issuesOf('suite: [unclosed')).toMatch(/YAML/);
  });

  it('rejects unknown grader types', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: vibes }') }))).toMatch(/tasks\.0\.graders\.0/);
  });

  it('rejects duplicate task ids', () => {
    const tasks = 'tasks:\n  - { id: a, prompt: x }\n  - { id: a, prompt: y }';
    expect(issuesOf(yaml({ tasks }))).toMatch(/duplicate task id "a"/);
  });

  it('rejects unknown servers referenced by tasks and graders', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: tool_called, tool: x }', '\n    servers: [nope]') }))).toMatch(
      /tasks\.t1\.servers: unknown server "nope"/,
    );
    expect(issuesOf(yaml({ tasks: task('      - { type: tool_called, tool: x, server: ghost }') }))).toMatch(
      /tasks\.t1\.graders\[0\]\.server: unknown server "ghost"/,
    );
  });

  it('rejects placeholder, unpinned, and malformed model ids', () => {
    expect(issuesOf(yaml({ models: 'models: ["anthropic/<sonnet>"]' }))).toMatch(/unresolved placeholder/);
    expect(issuesOf(yaml({ models: 'models: [openrouter/auto]' }))).toMatch(/not pinned/);
    expect(issuesOf(yaml({ models: 'models: [openai/gpt-latest]' }))).toMatch(/not pinned/);
    expect(issuesOf(yaml({ models: 'models: [gpt4]' }))).toMatch(/not a provider\/model id/);
  });

  it('rejects unpinned fixture refs and placeholder fixture urls', () => {
    expect(issuesOf(yaml({ fixture: 'fixture: { git: "https://x/r.git", ref: main }' }))).toMatch(/commit sha/);
    expect(issuesOf(yaml({ fixture: 'fixture: { git: "https://github.com/<org>/r", ref: "0123abcd" }' }))).toMatch(
      /fixture\.git contains an unresolved placeholder/,
    );
  });

  it('rejects {fixture} when the suite has no fixture', () => {
    expect(issuesOf(yaml({ servers: 'servers:\n  fs: { command: npx, args: ["{fixture}"] }' }))).toMatch(
      /servers\.fs uses \{fixture\} but the suite has no fixture/,
    );
  });

  it('rejects servers with neither or both of command and url', () => {
    expect(issuesOf(yaml({ servers: 'servers:\n  x: { args: [] }' }))).toMatch(/exactly one of command or url/);
  });

  // Review Focus 4
  it('rejects fs_state paths that escape the workspace', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: fs_state, path: ../secret }') }))).toMatch(
      /must be relative and stay inside the workspace/,
    );
    expect(issuesOf(yaml({ tasks: task('      - { type: fs_state, path: /etc/passwd }') }))).toMatch(
      /must be relative and stay inside the workspace/,
    );
  });

  // Review Focus 5
  it('rejects invalid regex in answer_matches', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: answer_matches, pattern: "([a-z" }') }))).toMatch(/invalid regex/);
  });

  it('parses pinned model objects, the judge block, and tool_timeout_s', () => {
    const s = parseSuite(
      yaml({
        models: [
          'models:',
          '  - { id: anthropic/claude-sonnet-5.5, provider: anthropic }',
          '  - qwen/qwen3.8-flash',
          'judge: { id: anthropic/claude-haiku-5.5, provider: anthropic }',
          'defaults: { tool_timeout_s: 30 }',
        ].join('\n'),
      }),
    );
    expect(s.models).toEqual(['anthropic/claude-sonnet-5.5', 'qwen/qwen3.8-flash']);
    expect(s.modelPins).toEqual({ 'anthropic/claude-sonnet-5.5': 'anthropic' });
    expect(s.judge).toEqual({ id: 'anthropic/claude-haiku-5.5', provider: 'anthropic' });
    expect(s.defaults.toolTimeoutS).toBe(30);
    expect(s.defaults.repeats).toBe(3);
  });

  it('defaults to no pins, no judge, and a 60 s tool timeout', () => {
    const s = parseSuite(yaml());
    expect(s.modelPins).toEqual({});
    expect(s.judge).toBeUndefined();
    expect(s.defaults.toolTimeoutS).toBe(60);
  });

  it('rejects bad provider slugs, bad judges, and models listed twice in either form', () => {
    expect(issuesOf(yaml({ models: 'models: [{ id: a/b, provider: "Anthropic Inc" }]' }))).toMatch(/models\.0/);
    expect(issuesOf(yaml({ models: 'models: [a/b]\njudge: { id: openrouter/auto, provider: x }' }))).toMatch(
      /judge: "openrouter\/auto" is not pinned/,
    );
    expect(issuesOf(yaml({ models: 'models: [a/b]\njudge: { id: haiku }' }))).toMatch(/judge/);
    expect(issuesOf(yaml({ models: 'models: [a/b, { id: a/b, provider: x }]' }))).toMatch(/models: "a\/b" is listed twice/);
  });

  it('rejects {fixture} in a task prompt when the suite has no fixture', () => {
    expect(issuesOf(yaml({ tasks: 'tasks:\n  - { id: t1, prompt: "look in {fixture}" }' }))).toMatch(
      /tasks\.t1\.prompt uses \{fixture\} but the suite has no fixture/,
    );
  });
});

describe('loadSuite', () => {
  it('reads a file and records its path as source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'suite-'));
    const path = join(dir, 's.yaml');
    await writeFile(path, yaml());
    const s = await loadSuite(path);
    expect(s.source).toBe(path);
    expect(s.tasks).toHaveLength(1);
  });
});
