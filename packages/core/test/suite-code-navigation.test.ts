import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureManager } from '../src/fixtures/manager.js';
import { runGraders } from '../src/graders.js';
import { previewPlan } from '../src/runner/run.js';
import { loadSuite } from '../src/suite/load.js';
import type { Suite } from '../src/types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const suite: Suite = await loadSuite(join(ROOT, 'suites/code-navigation.yaml'));

/** A checkout of the pinned fixture: $MCP_EVALS_FIXTURE_DIR, or the CLI's default fixture cache. Undefined offline. */
function fixtureDir(s: Suite): string | undefined {
  const fromEnv = process.env.MCP_EVALS_FIXTURE_DIR;
  const dir = fromEnv ? resolve(fromEnv) : new FixtureManager({ cacheDir: join(ROOT, '.mcp-evals/cache') }).cachePath(s.fixture!);
  return existsSync(join(dir, '.git')) ? dir : undefined;
}

const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const PATH = /^[\w.-]+(\/[\w.-]+)*\/[\w.-]+\.[a-z]+$/;

describe('suites/code-navigation.yaml', () => {
  it('pins the fixture, servers and models from the M2 spec', () => {
    expect(suite.fixture).toEqual({ git: 'https://github.com/honojs/hono', ref: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa' });
    expect(suite.servers).toEqual({
      neatcode: { command: 'npx', args: ['-y', '@neatcodeai/mcp@0.1.5'], env: {}, headers: {}, setup: 'npx -y @neatcodeai/cli@0.1.5 init' },
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '{fixture}'], env: {}, headers: {} },
    });
    expect(suite.models).toEqual(['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.8-flash', 'qwen/qwen3.8-flash']);
    expect(suite.modelPins).toEqual({
      'anthropic/claude-sonnet-5.5': 'anthropic',
      'openai/gpt-6.1-sol': 'openai',
      'google/gemini-3.8-flash': 'google-ai-studio',
      'qwen/qwen3.8-flash': 'alibaba',
    });
    expect(suite.defaults).toEqual({ repeats: 2, maxSteps: 12, timeoutS: 180, temperature: 0, toolTimeoutS: 60 });
  });

  it('has 12 deterministic tasks that run on both servers and say where the repository is', () => {
    expect(suite.tasks).toHaveLength(12);
    for (const t of suite.tasks) {
      expect(t.prompt).toContain('The repository is at {fixture}.');
      expect(t.servers).toBeUndefined();
      expect(t.graders.length).toBeGreaterThan(0);
      expect(t.graders.every((g) => g.type === 'answer_contains_all' || g.type === 'answer_matches')).toBe(true);
      // Neutral prompts: no hint about which tool or server to use.
      expect(t.prompt).not.toMatch(/\b(?:tool|neatcode|grep|search_|read_file|mcp)\b/i);
    }
    for (const id of ['preset-routers', 'strict-path', 'default-error-handler']) expect(suite.tasks.map((t) => t.id)).toContain(id);
  });

  it('plans 192 runs (12 tasks × 2 servers × 4 models × 2 repeats)', () => {
    expect(previewPlan({ suites: [suite] }).planned.reduce((s, c) => s + c.runs, 0)).toBe(192);
  });

  it('passes a correct reference answer for every task', async () => {
    expect(Object.keys(REFERENCE).sort()).toEqual(suite.tasks.map((t) => t.id).sort());
    for (const t of suite.tasks) {
      const failed = (await grade(t.id, REFERENCE[t.id]!)).filter((g) => !g.pass);
      expect(failed.map((g) => `${t.id}: ${g.type} ${g.detail}`)).toEqual([]);
    }
  });

  it('fails the reference answer once any decoy path is added to it', async () => {
    for (const t of suite.tasks) {
      for (const path of decoys(t.id)) {
        const graders = await grade(t.id, `${REFERENCE[t.id]!}\nAlso ${path}.`);
        expect(graders.some((g) => !g.pass), `${t.id} + ${path}`).toBe(true);
      }
    }
  });

  it('fails the near-miss answers the old substring graders accepted', async () => {
    for (const [task, answer] of NEAR_MISSES) {
      expect((await grade(task, answer)).some((g) => !g.pass), `${task}: ${answer}`).toBe(true);
    }
  });

  const dir = fixtureDir(suite);
  describe.skipIf(!dir)('answer key (needs a checkout of the pinned fixture)', () => {
    it('is checked out at the pinned commit', () => {
      expect(git(dir!, 'rev-parse', 'HEAD').stdout.trim()).toBe(suite.fixture!.ref);
    });

    it('names only paths that exist and symbols that occur under src/', () => {
      const missing: string[] = [];
      const files = git(dir!, 'ls-files', 'src').stdout.split('\n');
      for (const t of suite.tasks) {
        for (const g of t.graders) {
          if (g.type === 'answer_contains_all') {
            for (const v of g.values) {
              const ok = PATH.test(v) ? existsSync(join(dir!, v)) : git(dir!, 'grep', '-q', '-F', '-e', v, '--', 'src').status === 0;
              if (!ok) missing.push(`${t.id}: ${v}`);
            }
          } else if (g.type === 'answer_matches' && decoyPath(g.pattern) === undefined) {
            // Every escaped path in a positive pattern exists; every \bIdentifier\b occurs as a word under src/.
            for (const [, p] of g.pattern.matchAll(/((?:[\w-]+\/)+[\w-]+\\\.tsx?)/g)) {
              const path = p!.replace(/\\\./g, '.');
              if (!files.some((f) => f === path || f.endsWith(`/${path}`))) missing.push(`${t.id}: ${path}`);
            }
            for (const [, id] of g.pattern.matchAll(/\\b([A-Za-z_][A-Za-z0-9_]*)\\b/g)) {
              if (/^\d+$/.test(id!)) continue;
              if (git(dir!, 'grep', '-q', '-w', '-F', '-e', id!, '--', 'src').status !== 0) missing.push(`${t.id}: ${id}`);
            }
          }
        }
      }
      expect(missing).toEqual([]);
    });

    it('uses decoys that exist and do not contain the symbol the task asks about', () => {
      const wrong: string[] = [];
      for (const t of suite.tasks) {
        const paths = decoys(t.id);
        if (paths.length === 0) continue;
        const symbol = DECOY_SYMBOL[t.id];
        if (!symbol) {
          wrong.push(`${t.id}: no DECOY_SYMBOL entry`);
          continue;
        }
        for (const path of paths) {
          if (!existsSync(join(dir!, path))) wrong.push(`${t.id}: decoy ${path} does not exist`);
          else if (git(dir!, 'grep', '-q', ...(symbol.word ? ['-w'] : []), '-F', '-e', symbol.text, '--', path).status === 0) {
            wrong.push(`${t.id}: decoy ${path} contains ${symbol.text}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });
  });
});

/** The path a decoy pattern `^(?![\s\S]*<path>)[\s\S]*$` forbids; undefined for any other pattern. */
function decoyPath(pattern: string): string | undefined {
  const m = /^\^\(\?!\[\\s\\S\]\*(.+)\)\[\\s\\S\]\*\$$/.exec(pattern);
  return m ? m[1]!.replace(/\\\./g, '.') : undefined;
}

function decoys(taskId: string): string[] {
  const task = suite.tasks.find((t) => t.id === taskId)!;
  return task.graders.flatMap((g) => (g.type === 'answer_matches' ? (decoyPath(g.pattern) ?? []) : []));
}

/** What a decoy file must NOT contain, per task (the thing the task asks about). */
const DECOY_SYMBOL: Record<string, { text: string; word?: boolean }> = {
  'router-implementations': { text: 'implements Router' },
  'compose-callers': { text: 'compose', word: true },
  'cookie-helper-importers': { text: 'helper/cookie' },
  'timing-safe-callers': { text: 'timingSafeEqual' },
  'rename-check-optional-parameter': { text: 'checkOptionalParameter' },
  'http-exception-throwers': { text: 'HTTPException' },
};

async function grade(taskId: string, answer: string) {
  const task = suite.tasks.find((t) => t.id === taskId)!;
  return runGraders(task.graders, {
    server: 'filesystem', finalAnswer: answer, events: [], steps: 1, contextTokens: 0,
    workspace: { dir: ROOT, snapshot: new Map() }, taskPrompt: task.prompt,
  });
}

/** Correct answers, written the way a model plausibly would. */
const REFERENCE: Record<string, string> = {
  'router-implementations': [
    '- LinearRouter — src/router/linear-router/router.ts',
    '- PatternRouter — src/router/pattern-router/router.ts',
    '- PreparedRegExpRouter — src/router/reg-exp-router/prepared-router.ts',
    '- RegExpRouter — src/router/reg-exp-router/router.ts',
    '- SmartRouter — src/router/smart-router/router.ts',
    '- TrieRouter — src/router/trie-router/router.ts',
  ].join('\n'),
  'compose-callers': [
    'src/hono-base.ts:',
    '- route — wraps sub-app handlers with compose([], app.errorHandler)',
    '- #dispatch — composes the matched handlers when more than one matches',
    'src/middleware/combine/index.ts:',
    '- every — the inner `every` middleware calls compose(...)',
  ].join('\n'),
  'strict-path': 'getPathNoStrict, defined in src/utils/url.ts.',
  'preset-routers': [
    'src/hono.ts: SmartRouter with RegExpRouter and TrieRouter',
    'src/preset/quick.ts: SmartRouter with LinearRouter and TrieRouter',
    'src/preset/tiny.ts: PatternRouter',
  ].join('\n'),
  'cookie-helper-importers': 'src/middleware/jwk/jwk.ts\nsrc/middleware/jwt/jwt.ts\nsrc/middleware/language/language.ts\nsrc/validator/validator.ts',
  'timing-safe-callers': 'src/middleware/basic-auth/index.ts — basicAuth\nsrc/middleware/bearer-auth/index.ts — bearerAuth',
  'rename-check-optional-parameter': 'src/router/linear-router/router.ts\nsrc/router/reg-exp-router/router.ts\nsrc/router/trie-router/router.ts',
  'two-merge-paths':
    'mergePath in src/utils/url.ts is used by src/hono-base.ts; mergePath in src/client/utils.ts is used by src/client/client.ts.',
  'fetch-to-compose': [
    '1. fetch (src/hono-base.ts) calls #dispatch',
    '2. #dispatch (src/hono-base.ts) calls this.router.match(method, path)',
    '3. with more than one handler, #dispatch calls compose (src/compose.ts)',
  ].join('\n'),
  'default-error-handler':
    'errorHandler in src/hono-base.ts calls err.getResponse(), defined on HTTPException in src/http-exception.ts; any other error gets status 500.',
  'http-exception-throwers': [
    'src/middleware/basic-auth/index.ts', 'src/middleware/bearer-auth/index.ts', 'src/middleware/body-limit/index.ts', 'src/middleware/csrf/index.ts',
    'src/middleware/ip-restriction/index.ts', 'src/middleware/jwk/jwk.ts', 'src/middleware/jwt/jwt.ts', 'src/middleware/timeout/index.ts (rejects with it)',
  ].join('\n'),
  'smart-router-fallback': 'UnsupportedPathError, defined in src/router.ts; thrown by LinearRouter, PatternRouter and RegExpRouter.',
};

/** Wrong answers that the previous substring graders passed. */
const NEAR_MISSES: Array<[string, string]> = [
  // RegExpRouter only as part of PreparedRegExpRouter.
  ['router-implementations', REFERENCE['router-implementations']!.replace('- RegExpRouter — src/router/reg-exp-router/router.ts', '- (and src/router/reg-exp-router/router.ts)')],
  ['smart-router-fallback', 'UnsupportedPathError, defined in src/router.ts; thrown by LinearRouter, PatternRouter and PreparedRegExpRouter.'],
  // "route" and "every" only as English words.
  [
    'compose-callers',
    'src/hono-base.ts: #dispatch composes the handlers of the matched route.\nsrc/middleware/combine/index.ts: some.\n\n' +
      'This is how the composition works for the whole application, so that the handlers for a request run in order, and the chain ends at every final response.',
  ],
  // Routers named, but swapped between entry points.
  ['preset-routers', 'src/hono.ts: PatternRouter\nsrc/preset/quick.ts: SmartRouter with RegExpRouter and TrieRouter\nsrc/preset/tiny.ts: SmartRouter with LinearRouter and TrieRouter'],
  // match/compose only as English words.
  ['fetch-to-compose', 'fetch in src/hono-base.ts calls #dispatch, which finds the handlers that match and has them composed (src/compose.ts).'],
  // 5000 is not 500.
  ['default-error-handler', 'errorHandler in src/hono-base.ts calls getResponse() from src/http-exception.ts; other errors get status 5000.'],
];
