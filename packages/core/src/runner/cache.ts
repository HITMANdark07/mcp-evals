import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../errors.js';
import type { RunRecord, Suite } from '../types.js';
import { isPlainObject, sha256Hex } from '../util.js';

export const DEFAULT_RUNS_DIR = '.mcp-evals/runs';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What must stay identical between a run and its resumptions. */
export interface RunIdentity {
  provider: string;
  suites: Array<{ name: string; hash: string }>;
  models: string[] | null;
  servers: string[] | null;
  tasks: string[] | null;
  repeats: number | null;
}

export interface RunManifest extends RunIdentity {
  manifestVersion: 1;
  runId: string;
  createdAt: string;
  harnessVersion: string;
  /** Spend with no record: a run cut off by the budget cap or by out-of-credits. */
  unrecordedSpendUsd: number;
}

const ManifestSchema = z.object({
  manifestVersion: z.literal(1),
  runId: z.string(),
  createdAt: z.string(),
  harnessVersion: z.string(),
  provider: z.string(),
  suites: z.array(z.object({ name: z.string(), hash: z.string() })),
  models: z.array(z.string()).nullable(),
  servers: z.array(z.string()).nullable(),
  tasks: z.array(z.string()).nullable(),
  repeats: z.number().int().positive().nullable(),
  unrecordedSpendUsd: z.number().nonnegative(),
});

/** Content hash of a parsed suite. `source` is where the file lives, not what it says, so moving it does not block a resume. */
export function suiteHash(suite: Suite): string {
  return sha256Hex(JSON.stringify({ ...suite, source: undefined }));
}

export function identityOf(o: { provider: string; suites: Suite[]; models?: string[]; servers?: string[]; tasks?: string[]; repeats?: number }): RunIdentity {
  const sorted = (xs?: string[]) => (xs ? [...xs].sort() : null);
  return {
    provider: o.provider,
    suites: o.suites.map((s) => ({ name: s.name, hash: suiteHash(s) })),
    models: sorted(o.models),
    servers: sorted(o.servers),
    tasks: sorted(o.tasks),
    repeats: o.repeats ?? null,
  };
}

export class RunCache {
  private constructor(
    readonly dir: string,
    private current: RunManifest,
  ) {}

  get manifest(): RunManifest {
    return this.current;
  }

  get recordsPath(): string {
    return join(this.dir, `${this.current.runId}.jsonl`);
  }

  get manifestPath(): string {
    return manifestPath(this.dir, this.current.runId);
  }

  static async create(dir: string, init: { runId: string; createdAt: string; harnessVersion: string; identity: RunIdentity }): Promise<RunCache> {
    assertRunId(init.runId);
    if (existsSync(manifestPath(dir, init.runId))) throw new ConfigError(`run "${init.runId}" already exists in ${dir}`);
    await mkdir(dir, { recursive: true });
    const cache = new RunCache(dir, {
      manifestVersion: 1,
      runId: init.runId,
      createdAt: init.createdAt,
      harnessVersion: init.harnessVersion,
      ...init.identity,
      unrecordedSpendUsd: 0,
    });
    await writeFile(cache.recordsPath, '');
    await writeAtomic(cache.manifestPath, `${JSON.stringify(cache.current, null, 2)}\n`);
    return cache;
  }

  static async open(dir: string, runId: string): Promise<RunCache> {
    assertRunId(runId);
    const path = manifestPath(dir, runId);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigError(`no cached run "${runId}" in ${dir} (looked for ${path})`);
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ConfigError(`corrupt run manifest ${path}: not JSON`);
    }
    const parsed = ManifestSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
      throw new ConfigError(`corrupt run manifest ${path}: ${issues.join('; ')}`);
    }
    if (parsed.data.runId !== runId) throw new ConfigError(`corrupt run manifest ${path}: it describes run "${parsed.data.runId}"`);
    return new RunCache(dir, parsed.data);
  }

  /** Throws a ConfigError naming every difference between the cached run and `identity`. */
  assertCompatible(identity: RunIdentity): void {
    const m = this.current;
    const diffs: string[] = [];
    if (m.provider !== identity.provider) diffs.push(`provider: cached "${m.provider}", now "${identity.provider}"`);
    if (JSON.stringify(m.suites) !== JSON.stringify(identity.suites)) {
      const fmt = (s: RunIdentity['suites']) => s.map((x) => `${x.name}@${x.hash.slice(0, 12)}`).join(', ');
      diffs.push(`suites: cached [${fmt(m.suites)}], now [${fmt(identity.suites)}]`);
    }
    for (const key of ['models', 'servers', 'tasks', 'repeats'] as const) {
      if (JSON.stringify(m[key]) !== JSON.stringify(identity[key])) {
        diffs.push(`--${key}: cached ${JSON.stringify(m[key])}, now ${JSON.stringify(identity[key])}`);
      }
    }
    if (diffs.length > 0) {
      throw new ConfigError(`cannot resume run ${m.runId}: the configuration changed:\n  - ${diffs.join('\n  - ')}`);
    }
  }

  /** Finished records, last write per runKey winning. Repairs a final line cut off mid-append. */
  async records(): Promise<RunRecord[]> {
    let text: string;
    try {
      text = await readFile(this.recordsPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const lines = text.split('\n');
    // A file that does not end in a newline was cut off mid-append (the process died).
    const tail = text.endsWith('\n') ? '' : (lines.pop() ?? '');
    const byKey = new Map<string, RunRecord>();
    lines.forEach((line, i) => {
      if (line.trim() === '') return;
      const value = parseLine(line);
      if (value === undefined) throw new ConfigError(`corrupt run cache ${this.recordsPath}: line ${i + 1} is not JSON`);
      if (!isRunRecord(value)) throw new ConfigError(`corrupt run cache ${this.recordsPath}: line ${i + 1} is not a run record`);
      byKey.set(value.runKey, value);
    });
    if (tail.trim() !== '') {
      const value = parseLine(tail);
      if (isRunRecord(value)) {
        byKey.set(value.runKey, value);
        await appendFile(this.recordsPath, '\n');
      } else {
        // Drop the partial line so later appends stay parseable; that run simply runs again.
        await writeAtomic(this.recordsPath, text.slice(0, text.length - tail.length));
      }
    }
    return [...byKey.values()];
  }

  async append(record: RunRecord): Promise<void> {
    await appendFile(this.recordsPath, `${JSON.stringify(record)}\n`);
  }

  async addUnrecordedSpend(usd: number): Promise<void> {
    if (!(usd > 0)) return;
    this.current = { ...this.current, unrecordedSpendUsd: this.current.unrecordedSpendUsd + usd };
    await writeAtomic(this.manifestPath, `${JSON.stringify(this.current, null, 2)}\n`);
  }
}

function manifestPath(dir: string, runId: string): string {
  return join(dir, `${runId}.manifest.json`);
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new ConfigError(`invalid run id "${runId}": use letters, digits, ".", "_" and "-" only`);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function isRunRecord(v: unknown): v is RunRecord {
  return isPlainObject(v) && typeof v.runKey === 'string' && typeof v.suite === 'string' && typeof v.outcome === 'string' && isPlainObject(v.trace);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}
