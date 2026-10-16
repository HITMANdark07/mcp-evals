import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConfigError, readResults, type Results } from '@mcp-evals/core';

export function fsReason(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'no such file';
  if (code === 'EACCES') return 'permission denied';
  if (code === 'EISDIR') return 'is a directory';
  return e instanceof Error ? e.message : String(e);
}

/** Reads results.json (v1 or v2) and returns it as v2. Every failure is a ConfigError naming the file. */
export async function readResultsFile(path: string): Promise<Results> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read results file ${abs}: ${fsReason(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid results file ${abs}: ${(e as Error).message}`);
  }
  try {
    return readResults(json);
  } catch (e) {
    if (e instanceof ConfigError) throw new ConfigError(`invalid results file ${abs}: ${e.message}`);
    throw e;
  }
}

/** Writes through a temp file and a rename, so readers never see a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const abs = resolve(path);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, data);
  await rename(tmp, abs);
}
