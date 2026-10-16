import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.js';
import { parseSuite } from '../suite/load.js';
import type { RunRecord } from '../types.js';
import { identityOf, RunCache, suiteHash } from './cache.js';

const SUITE = `
suite: demo
version: 1
servers:
  fake: { command: unused }
models: [mock/a, mock/b]
tasks:
  - id: t
    prompt: "ECHO"
`;

function rec(runKey: string, costUsd = 0.01): RunRecord {
  const base = {
    runKey, suite: 'demo', server: 'fake', model: 'mock/a', task: 't', repeat: 0,
    outcome: 'pass' as const, end: 'final_answer' as const, graders: [], attempts: 1,
    costUsd, steps: 1, contextTokens: 5, latencyMs: 3,
  };
  return { ...base, toolSelectionOk: null, trace: { ...base, events: [], serverStderr: '' } };
}

async function fresh(runId = 'run-1') {
  const dir = join(await mkdtemp(join(tmpdir(), 'cache-')), 'runs');
  const identity = identityOf({ provider: 'mock', suites: [parseSuite(SUITE, 'a.yaml')], models: ['mock/b', 'mock/a'] });
  const cache = await RunCache.create(dir, { runId, createdAt: '2026-10-16T00:00:00.000Z', harnessVersion: '0.0.0', identity });
  return { dir, identity, cache };
}

describe('identityOf / suiteHash', () => {
  it('sorts filters, uses null for absent ones, and hashes suites by content, not path', () => {
    const a = parseSuite(SUITE, 'a.yaml');
    const moved = parseSuite(SUITE, 'somewhere/else.yaml');
    const edited = parseSuite(SUITE.replace('"ECHO"', '"ECHO now"'), 'a.yaml');
    expect(suiteHash(a)).toBe(suiteHash(moved));
    expect(suiteHash(a)).not.toBe(suiteHash(edited));
    expect(identityOf({ provider: 'mock', suites: [a], models: ['b/x', 'a/x'], repeats: 2 })).toEqual({
      provider: 'mock', suites: [{ name: 'demo', hash: suiteHash(a) }], models: ['a/x', 'b/x'], servers: null, tasks: null, repeats: 2,
    });
  });
});

describe('RunCache', () => {
  it('creates a manifest and an empty record file, and refuses to create the same run twice', async () => {
    const { dir, identity, cache } = await fresh();
    expect(existsSync(cache.recordsPath)).toBe(true);
    expect(JSON.parse(await readFile(cache.manifestPath, 'utf8'))).toEqual({
      manifestVersion: 1, runId: 'run-1', createdAt: '2026-10-16T00:00:00.000Z', harnessVersion: '0.0.0', ...identity, unrecordedSpendUsd: 0,
    });
    await expect(RunCache.create(dir, { runId: 'run-1', createdAt: 'x', harnessVersion: '0', identity })).rejects.toThrow(/already exists/);
  });

  it('round-trips appended records through open(), last write per runKey winning', async () => {
    const { dir, cache } = await fresh();
    await cache.append(rec('k1', 0.01));
    await cache.append(rec('k2', 0.02));
    await cache.append(rec('k1', 0.03));
    const reopened = await RunCache.open(dir, 'run-1');
    const records = await reopened.records();
    expect(records.map((r) => [r.runKey, r.costUsd])).toEqual([['k1', 0.03], ['k2', 0.02]]);
  });

  it('rejects unknown and unsafe run ids with a ConfigError', async () => {
    const { dir } = await fresh();
    await expect(RunCache.open(dir, 'nope')).rejects.toThrow(/no cached run "nope"/);
    await expect(RunCache.open(dir, '../escape')).rejects.toBeInstanceOf(ConfigError);
    await expect(RunCache.open(dir, 'a/b')).rejects.toThrow(/invalid run id/);
  });

  it('accepts the same configuration and names every difference otherwise', async () => {
    const { cache, identity } = await fresh();
    expect(() => cache.assertCompatible(identity)).not.toThrow();
    const edited = parseSuite(SUITE.replace('"ECHO"', '"ECHO now"'), 'a.yaml');
    const changed = identityOf({ provider: 'openrouter', suites: [edited], models: ['mock/a'], repeats: 1 });
    let err: unknown;
    try {
      cache.assertCompatible(changed);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toMatch(/cannot resume run run-1: the configuration changed/);
    expect(message).toMatch(/provider: cached "mock", now "openrouter"/);
    expect(message).toMatch(/suites: cached \[demo@/);
    expect(message).toMatch(/--models: cached \["mock\/a","mock\/b"\], now \["mock\/a"\]/);
    expect(message).toMatch(/--repeats: cached null, now 1/);
  });

  // Review Focus 3
  it('drops a final line cut off mid-append, so that run runs again and later appends stay parseable', async () => {
    const { dir, cache } = await fresh();
    await cache.append(rec('k1'));
    await appendFile(cache.recordsPath, JSON.stringify(rec('k2')).slice(0, 40));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1']);
    await cache.append(rec('k3'));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1', 'k3']);
  });

  it('keeps a complete final record that lacks its newline, and terminates it before the next append', async () => {
    const { dir, cache } = await fresh();
    await writeFile(cache.recordsPath, JSON.stringify(rec('k1')));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1']);
    await cache.append(rec('k2'));
    expect((await (await RunCache.open(dir, 'run-1')).records()).map((r) => r.runKey)).toEqual(['k1', 'k2']);
  });

  it('refuses a corrupt line in the middle of the cache', async () => {
    const { cache } = await fresh();
    await writeFile(cache.recordsPath, `${JSON.stringify(rec('k1'))}\n{oops\n${JSON.stringify(rec('k2'))}\n`);
    await expect(cache.records()).rejects.toThrow(/line 2 is not JSON/);
    await writeFile(cache.recordsPath, `${JSON.stringify({ hello: 'world' })}\n`);
    await expect(cache.records()).rejects.toThrow(/line 1 is not a run record/);
  });

  it('does not truncate an existing records file when creating a run with an orphaned cache', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'cache-')), 'runs');
    const identity = identityOf({ provider: 'mock', suites: [parseSuite(SUITE, 'a.yaml')] });
    const first = await RunCache.create(dir, { runId: 'run-1', createdAt: 'x', harnessVersion: '0', identity });
    await first.append(rec('k1'));
    await rm(first.manifestPath);
    const err = await RunCache.create(dir, { runId: 'run-1', createdAt: 'x', harnessVersion: '0', identity }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/run cache already exists for run "run-1"/);
    expect(await readFile(first.recordsPath, 'utf8')).toBe(`${JSON.stringify(rec('k1'))}\n`);
  });

  it('serializes manifest writes so concurrent spend additions all persist', async () => {
    const { dir, cache } = await fresh();
    await Promise.all(Array.from({ length: 20 }, () => cache.addUnrecordedSpend(0.01)));
    expect((await RunCache.open(dir, 'run-1')).manifest.unrecordedSpendUsd).toBeCloseTo(0.2, 12);
  });

  it('rejects a negative or non-finite spend amount and leaves the manifest unchanged', async () => {
    const { dir, cache } = await fresh();
    await expect(cache.addUnrecordedSpend(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(cache.addUnrecordedSpend(Number.NaN)).rejects.toThrow('unrecorded spend must be a finite number >= 0');
    await expect(cache.addUnrecordedSpend(Number.POSITIVE_INFINITY)).rejects.toBeInstanceOf(RangeError);
    expect((await RunCache.open(dir, 'run-1')).manifest.unrecordedSpendUsd).toBe(0);
  });

  it('persists spend that has no record (a budget or out-of-credits cut-off)', async () => {
    const { dir, cache } = await fresh();
    await cache.addUnrecordedSpend(0.004);
    await cache.addUnrecordedSpend(0);
    await cache.addUnrecordedSpend(0.001);
    expect((await RunCache.open(dir, 'run-1')).manifest.unrecordedSpendUsd).toBeCloseTo(0.005, 12);
  });
});
