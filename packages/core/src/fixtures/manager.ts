import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { InfraError } from '../errors.js';
import type { FixtureSpec } from '../types.js';
import { sha256Hex } from '../util.js';

const execFileP = promisify(execFile);

export interface Workspace {
  dir: string;
  /** posix relative path → sha256 hex, taken before the run. */
  snapshot: Map<string, string>;
  dispose(): Promise<void>;
}

export interface FixtureManagerOptions {
  cacheDir: string;
  workRoot?: string;
}

export class FixtureManager {
  constructor(private readonly opts: FixtureManagerOptions) {}

  cachePath(spec: FixtureSpec): string {
    const key = createHash('sha256').update(`${spec.git}@${spec.ref}`).digest('hex').slice(0, 16);
    return join(this.opts.cacheDir, key);
  }

  async prepare(spec: FixtureSpec): Promise<string> {
    const dir = this.cachePath(spec);
    if (await isCheckedOutAt(dir, spec.ref)) return dir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(this.opts.cacheDir, { recursive: true });
    try {
      await execFileP('git', ['clone', '--quiet', '--no-checkout', spec.git, dir]);
      await execFileP('git', ['-C', dir, 'checkout', '--quiet', '--detach', spec.ref]);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw new InfraError('fixture', `failed to fetch fixture ${spec.git}@${spec.ref}: ${(e as Error).message}`, false);
    }
    return dir;
  }

  async createWorkspace(spec?: FixtureSpec): Promise<Workspace> {
    const root = this.opts.workRoot ?? tmpdir();
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'mcp-evals-ws-'));
    if (spec) {
      const src = await this.prepare(spec);
      await cp(src, dir, { recursive: true, filter: (p) => relative(src, p).split(sep)[0] !== '.git' });
    }
    const snapshot = await snapshotDir(dir);
    return { dir, snapshot, dispose: () => rm(dir, { recursive: true, force: true }) };
  }
}

async function isCheckedOutAt(dir: string, ref: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false;
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return stdout.trim().startsWith(ref);
  } catch {
    return false;
  }
}

export async function snapshotDir(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.set(relative(root, full).split(sep).join('/'), sha256Hex(await readFile(full)));
    }
  }
  await walk(root);
  return out;
}
