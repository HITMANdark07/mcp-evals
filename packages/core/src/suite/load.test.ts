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

  it('accepts local name:tag model ids (e.g. Ollama) plain or with a provider, but not :latest', () => {
    const s = parseSuite(yaml({ models: 'models: [qwen3:8b, { id: llama3.2:1b, provider: ollama }]' }));
    expect(s.models).toEqual(['qwen3:8b', 'llama3.2:1b']);
    expect(s.modelPins).toEqual({ 'llama3.2:1b': 'ollama' });
    expect(issuesOf(yaml({ models: 'models: [qwen3:latest]' }))).toMatch(/not pinned/);
    expect(issuesOf(yaml({ models: 'models: [gpt4]' }))).toMatch(/not a provider\/model id \(or a local name:tag id/);
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
  it('parses answer_json_schema and llm_judge graders', () => {
    const s = parseSuite(
      yaml({
        models: 'models: [mock/a]\njudge: { id: anthropic/claude-haiku-5.5, provider: anthropic }',
        tasks: task(
          [
            '      - { type: answer_json_schema, schema: { type: object, required: [n], properties: { n: { type: integer } } } }',
            '      - { type: llm_judge, rubric: "Explains it.", pass_threshold: 0.7 }',
          ].join('\n'),
        ),
      }),
    );
    expect(s.tasks[0]!.graders).toEqual([
      { type: 'answer_json_schema', schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } },
      { type: 'llm_judge', rubric: 'Explains it.', passThreshold: 0.7 },
    ]);
  });

  it('rejects llm_judge without a suite judge, and unsupported JSON Schema keywords', () => {
    expect(issuesOf(yaml({ tasks: task('      - { type: llm_judge, rubric: "x" }') }))).toMatch(
      /tasks\.t1\.graders\[0\]: llm_judge needs a suite-level judge: block/,
    );
    expect(issuesOf(yaml({ tasks: task('      - { type: answer_json_schema, schema: { type: array, maxItems: 2 } }') }))).toMatch(
      /tasks\.0\.graders\.0\.schema/,
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

describe('task vars', () => {
  const withVars = (vars: string) =>
    yaml({ tasks: ['tasks:', '  - id: t', '    prompt: "Do {task}"', `    vars: ${vars}`, '    graders: [{ type: tool_called, tool: echo }]'].join('\n') });
  it('parses vars into the task', () => {
    expect(parseSuite(withVars('{ task: damaged_item, seed: "7" }')).tasks[0]!.vars).toEqual({ task: 'damaged_item', seed: '7' });
  });
  it('rejects reserved and malformed names', () => {
    expect(() => parseSuite(withVars('{ fixture: x }'))).toThrow(/reserved/);
    expect(() => parseSuite(withVars('{ suite_dir: x }'))).toThrow(/reserved/);
    expect(() => parseSuite(withVars('{ Seed: "1" }'))).toThrow(/vars/);
    expect(() => parseSuite(withVars('{ seed1: "1" }'))).toThrow(/vars/);
  });
});

describe('hidden_tools and env_reward', () => {
  const suiteWith = (server: string, grader: string) =>
    yaml({ servers: `servers:\n  env: ${server}`, tasks: ['tasks:', '  - id: t', '    prompt: "go"', `    graders: [${grader}]`].join('\n') });
  it('parses hidden tools and env_reward with a default min of 1', () => {
    const s = parseSuite(suiteWith('{ command: node, hidden_tools: [__score] }', '{ type: env_reward, tool: __score }'));
    expect(s.servers.env!.hiddenTools).toEqual(['__score']);
    expect(s.tasks[0]!.graders[0]).toEqual({ type: 'env_reward', tool: '__score', min: 1 });
  });
  it('rejects a min outside 0..1', () => {
    expect(() => parseSuite(suiteWith('{ command: node }', '{ type: env_reward, tool: s, min: 2 }'))).toThrow(/min/);
  });
});
