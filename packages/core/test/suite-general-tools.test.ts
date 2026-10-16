import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FixtureManager } from '../src/fixtures/manager.js';
import { previewPlan } from '../src/runner/run.js';
import { loadSuite } from '../src/suite/load.js';
import type { Suite } from '../src/types.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const suite: Suite = await loadSuite(join(ROOT, 'suites/general-tools.yaml'));

/** Tools registered by the pinned server versions. */
const TOOLS: Record<string, string[]> = {
  filesystem: [
    'create_directory', 'directory_tree', 'edit_file', 'get_file_info', 'list_allowed_directories', 'list_directory',
    'list_directory_with_sizes', 'move_file', 'read_file', 'read_media_file', 'read_multiple_files', 'read_text_file', 'search_files', 'write_file',
  ],
  memory: ['add_observations', 'create_entities', 'create_relations', 'delete_entities', 'delete_observations', 'delete_relations', 'open_nodes', 'read_graph', 'search_nodes'],
};

/** A checkout of the pinned fixture: $MCP_EVALS_FIXTURE_DIR, or the CLI's default fixture cache. Undefined offline. */
function fixtureDir(s: Suite): string | undefined {
  const fromEnv = process.env.MCP_EVALS_FIXTURE_DIR;
  const dir = fromEnv ? resolve(fromEnv) : new FixtureManager({ cacheDir: join(ROOT, '.mcp-evals/cache') }).cachePath(s.fixture!);
  return existsSync(join(dir, '.git')) ? dir : undefined;
}

describe('suites/general-tools.yaml', () => {
  it('pins the fixture, the filesystem and memory servers, the models, and the judge', () => {
    expect(suite.fixture).toEqual({ git: 'https://github.com/honojs/hono', ref: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa' });
    expect(suite.servers).toEqual({
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '{fixture}'], env: {}, headers: {} },
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'], env: { MEMORY_FILE_PATH: '{fixture}/.memory.json' }, headers: {} },
    });
    expect(Object.keys(suite.modelPins)).toEqual(suite.models);
    expect(suite.judge).toEqual({ id: 'anthropic/claude-haiku-5.5', provider: 'anthropic' });
  });

  it('has 12 tasks, each on exactly one server, at most 3 judged, with graders naming only real tools', () => {
    expect(suite.tasks).toHaveLength(12);
    const judged = suite.tasks.filter((t) => t.graders.some((g) => g.type === 'llm_judge'));
    expect(judged.length).toBeLessThanOrEqual(3);
    for (const t of suite.tasks) {
      expect(t.servers).toHaveLength(1);
      const server = t.servers![0]!;
      if (server === 'filesystem') expect(t.prompt).toContain('The repository is at {fixture}.');
      for (const g of t.graders) {
        if (g.type === 'tool_called' || g.type === 'tool_not_called' || g.type === 'tool_args_match') expect(TOOLS[server]).toContain(g.tool);
      }
    }
    expect(previewPlan({ suites: [suite] }).planned.reduce((s, c) => s + c.runs, 0)).toBe(96);
  });

  const dir = fixtureDir(suite);
  describe.skipIf(!dir)('answer key (needs a checkout of the pinned fixture)', () => {
    const read = (p: string) => readFileSync(join(dir!, p), 'utf8');
    it('matches the facts the graders expect', () => {
      expect(JSON.parse(read('package.json'))).toMatchObject({ name: 'hono', version: '4.13.13', license: 'MIT' });
      const middleware = readdirSync(join(dir!, 'src/middleware'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      expect(middleware).toHaveLength(27);
      expect(middleware).toEqual(expect.arrayContaining(['basic-auth', 'context-storage', 'jsx-renderer', 'method-not-allowed', 'trailing-slash']));
      const combine = read('src/middleware/combine/index.ts');
      expect(combine.match(/^export /gm)).toHaveLength(3);
      for (const name of ['some', 'every', 'except']) expect(combine).toContain(`export const ${name}`);
      expect(read('src/middleware/timeout/index.ts')).toMatch(/504[\s\S]*Gateway Timeout/);
      expect(read('src/middleware/powered-by/index.ts')).toContain("options?.serverName ?? 'Hono'");
      expect(read('docs/MIGRATION.md').startsWith('# Migration Guide')).toBe(true);
      expect(read('src/router/smart-router/router.ts')).toContain('UnsupportedPathError');
      for (const p of ['src/hono.ts', 'src/middleware/powered-by/index.test.ts']) expect(existsSync(join(dir!, p))).toBe(true);
      for (const p of ['EVAL_NOTES.md', 'docs/archive', '.memory.json']) expect(existsSync(join(dir!, p))).toBe(false);
    });
  });
});
