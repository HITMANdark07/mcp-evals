import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// Release consistency: the npm package, the bundled core and the GitHub Action must agree.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const cli = JSON.parse(read('../package.json')) as {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const core = JSON.parse(read('../../core/package.json')) as { private?: boolean; dependencies: Record<string, string> };
const action = parseYaml(read('../../../action.yml')) as {
  inputs: Record<string, { default?: string; required?: boolean }>;
  runs: { using: string; steps: { uses?: string }[] };
};

describe('mcp-arena package', () => {
  it('is the public mcp-arena package with both bin names', () => {
    expect(cli.name).toBe('mcp-arena');
    expect(cli.private).toBeUndefined();
    expect(cli.bin).toEqual({ 'mcp-arena': './dist/index.js', 'mcp-evals': './dist/index.js' });
    expect(cli.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  it('bundles the private core and declares its runtime dependencies itself', () => {
    expect(core.private).toBe(true);
    expect(cli.dependencies['@mcp-evals/core']).toBeUndefined();
    expect(cli.devDependencies?.['@mcp-evals/core']).toBe('workspace:*');
    for (const [dep, range] of Object.entries(core.dependencies)) expect(cli.dependencies[dep], dep).toBe(range);
    for (const range of Object.values(cli.dependencies)) expect(range).not.toMatch(/^workspace:/);
  });
});

describe('action.yml', () => {
  it('is a composite action that defaults to the current package version', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.inputs['mcp-arena-version']?.default).toBe(cli.version);
    expect(action.inputs.base?.required).toBe(true);
    expect(action.inputs.head?.required).toBe(true);
    expect(action.inputs['max-success-drop']?.default).toBe('5');
    expect(action.inputs['max-context-increase']?.default).toBe('20');
    expect(action.inputs.comment?.default).toBe('true');
  });

  it('pins every third-party action to a full commit SHA', () => {
    const uses = action.runs.steps.flatMap((s) => (s.uses ? [s.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});
