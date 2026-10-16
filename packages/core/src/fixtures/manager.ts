import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InfraError } from '../errors.js';
import type { FixtureSpec } from '../types.js';
import { sha256Hex } from '../util.js';

const execFileP = promisify(execFile);

/** git runs with the MCP SDK's minimal environment (never the API key) and can never stop to ask for credentials. */
function gitEnv(): Record<string, string> {
  return { ...getDefaultEnvironment(), GIT_TERMINAL_PROMPT: '0' };
}

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
  /** In-flight prepares keyed by cache path, so concurrent callers share one populate. */
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly opts: FixtureManagerOptions) {}

  cachePath(spec: FixtureSpec): string {
    const key = createHash('sha256').update(`${spec.git}@${spec.ref}`).digest('hex').slice(0, 16);
    return join(this.opts.cacheDir, key);
  }

  async prepare(spec: FixtureSpec): Promise<string> {
    const dir = this.cachePath(spec);
    const pending = this.inflight.get(dir);
    if (pending) return pending;
    const p = this.populate(spec, dir);
    this.inflight.set(dir, p);
    // Drop the memo once settled (success or failure) so a later call re-checks the disk.
    const settle = () => {
      if (this.inflight.get(dir) === p) this.inflight.delete(dir);
    };
    p.then(settle, settle);
    return p;
  }

  private async populate(spec: FixtureSpec, dir: string): Promise<string> {
    if (await isCheckedOutAt(dir, spec.ref)) return dir;
    await mkdir(this.opts.cacheDir, { recursive: true });
    // Build in a temp sibling and rename into place, so `dir` is never half-prepared.
    const tmp = `${dir}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await execFileP('git', ['clone', '--quiet', '--no-checkout', spec.git, tmp], { env: gitEnv() });
      await execFileP('git', ['-C', tmp, 'checkout', '--quiet', '--detach', spec.ref], { env: gitEnv() });
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true });
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
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: gitEnv() });
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
