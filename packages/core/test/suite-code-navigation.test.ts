import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureManager } from '../src/fixtures/manager.js';
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
      neatcode: { command: 'npx', args: ['-y', '@neatcodeai/mcp@0.1.4'], env: {}, headers: {}, setup: 'npx -y @neatcodeai/cli@0.1.4 init' },
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
      expect(t.graders.every((g) => g.type === 'answer_contains_all')).toBe(true);
    }
    for (const id of ['preset-routers', 'strict-path', 'default-error-handler']) expect(suite.tasks.map((t) => t.id)).toContain(id);
  });

  it('plans 192 runs (12 tasks × 2 servers × 4 models × 2 repeats)', () => {
    expect(previewPlan({ suites: [suite] }).planned.reduce((s, c) => s + c.runs, 0)).toBe(192);
  });

  const dir = fixtureDir(suite);
  describe.skipIf(!dir)('answer key (needs a checkout of the pinned fixture)', () => {
    it('is checked out at the pinned commit', () => {
      expect(git(dir!, 'rev-parse', 'HEAD').stdout.trim()).toBe(suite.fixture!.ref);
    });

    it('names only paths that exist and symbols that occur under src/', () => {
      const missing: string[] = [];
      for (const t of suite.tasks) {
        for (const g of t.graders) {
          if (g.type !== 'answer_contains_all') continue;
          for (const v of g.values) {
            const ok = PATH.test(v) ? existsSync(join(dir!, v)) : git(dir!, 'grep', '-q', '-F', '-e', v, '--', 'src').status === 0;
            if (!ok) missing.push(`${t.id}: ${v}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });
  });
});
