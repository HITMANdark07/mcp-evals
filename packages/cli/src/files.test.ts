import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { readResultsFile, writeFileAtomic } from './files.js';
import { cell, results } from './testing/results-fixture.js';

describe('files', () => {
  it('writes atomically, creating parent directories and leaving no temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'files-'));
    await writeFileAtomic(join(dir, 'a', 'b.txt'), 'hello');
    await writeFileAtomic(join(dir, 'a', 'b.txt'), new Uint8Array([104, 105]));
    expect(await readFile(join(dir, 'a', 'b.txt'), 'utf8')).toBe('hi');
    expect(await readdir(join(dir, 'a'))).toEqual(['b.txt']);
  });

  it('reads results files and names the file in every error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'files-'));
    const good = join(dir, 'good.json');
    await writeFile(good, JSON.stringify(results([cell({ server: 'neatcode', model: 'acme/a' })])));
    expect((await readResultsFile(good)).schemaVersion).toBe(2);
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{nope');
    const wrong = join(dir, 'wrong.json');
    await writeFile(wrong, JSON.stringify({ schemaVersion: 9 }));
    for (const path of [join(dir, 'missing.json'), bad, wrong]) {
      const err = await readResultsFile(path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(path);
    }
  });
});
