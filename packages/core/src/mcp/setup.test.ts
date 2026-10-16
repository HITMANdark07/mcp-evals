import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureManager } from '../fixtures/manager.js';
import { runSetup, setupEnv } from './setup.js';

const PLANTED = 'sk-or-planted-0123456789abcdef';
const saved = { key: process.env.OPENROUTER_API_KEY, trace: process.env.GIT_TRACE };

afterEach(() => {
  for (const [name, value] of [['OPENROUTER_API_KEY', saved.key], ['GIT_TRACE', saved.trace]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('runSetup', () => {
  it('never hands the API key (or any other non-default variable) to a setup command', async () => {
    process.env.OPENROUTER_API_KEY = PLANTED;
    const dir = await mkdtemp(join(tmpdir(), 'setup-env-'));
    await runSetup('env > env.txt', dir, setupEnv({ MY_VAR: '{fixture}/x' }, { fixture: dir }));
    const env = await readFile(join(dir, 'env.txt'), 'utf8');
    expect(env).not.toContain(PLANTED);
    expect(env).not.toContain('OPENROUTER_API_KEY');
    // The server's own env (with {vars} substituted) and a usable PATH are still there.
    expect(env).toContain(`MY_VAR=${dir}/x`);
    expect(env).toMatch(/^PATH=/m);
  });
});

describe('FixtureManager git commands', () => {
  it('run with a filtered environment (the parent environment does not reach git)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'setup-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    await writeFile(join(repo, 'a.txt'), 'a\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const ref = git('rev-parse', 'HEAD');
    const root = await mkdtemp(join(tmpdir(), 'setup-cache-'));
    // If git inherited the parent environment, GIT_TRACE would make it write this file.
    const trace = join(root, 'git-trace.txt');
    process.env.GIT_TRACE = trace;
    process.env.OPENROUTER_API_KEY = PLANTED;
    await new FixtureManager({ cacheDir: join(root, 'cache') }).prepare({ git: repo, ref });
    expect(existsSync(trace)).toBe(false);
  });
});
