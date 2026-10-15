import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { InfraError } from '../errors.js';
import { sha256Hex } from '../util.js';
import { FixtureManager } from './manager.js';

let repo: string;
let firstSha: string;
let secondSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'fixture-src-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  firstSha = git(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
  git(repo, 'commit', '-qam', 'two');
  secondSha = git(repo, 'rev-parse', 'HEAD');
});

async function manager() {
  const root = await mkdtemp(join(tmpdir(), 'fixture-mgr-'));
  return new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: join(root, 'work') });
}

describe('FixtureManager', () => {
  it('checks out the pinned ref, not HEAD', async () => {
    const m = await manager();
    const ws = await m.createWorkspace({ git: repo, ref: firstSha });
    expect(await readFile(join(ws.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(join(ws.dir, '.git'))).toBe(false);
    expect(ws.snapshot.get('src/a.ts')).toBe(sha256Hex('export const a = 1;\n'));
    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('accepts short shas and gives each run an isolated workspace', async () => {
    const m = await manager();
    const spec = { git: repo, ref: secondSha.slice(0, 8) };
    const a = await m.createWorkspace(spec);
    const b = await m.createWorkspace(spec);
    expect(a.dir).not.toBe(b.dir);
    await writeFile(join(a.dir, 'src', 'a.ts'), 'mutated');
    expect(await readFile(join(b.dir, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it('reuses the cache for the same ref', async () => {
    const m = await manager();
    const spec = { git: repo, ref: firstSha };
    const p1 = await m.prepare(spec);
    const p2 = await m.prepare(spec);
    expect(p1).toBe(p2);
    expect(p1).toBe(m.cachePath(spec));
  });

  it('creates an empty workspace without a fixture', async () => {
    const ws = await (await manager()).createWorkspace();
    expect(ws.snapshot.size).toBe(0);
    await ws.dispose();
  });

  it('throws a non-retryable InfraError for an unknown ref', async () => {
    const err = await (await manager()).prepare({ git: repo, ref: 'deadbeef' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'fixture', retryable: false });
  });
});
