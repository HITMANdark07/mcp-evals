import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from './env.js';

describe('loadDotEnv', () => {
  it('loads .env without overriding variables already set in the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    const path = join(dir, '.env');
    await writeFile(path, 'MCP_EVALS_TEST_A=from-file\nMCP_EVALS_TEST_B=from-file\n');
    process.env.MCP_EVALS_TEST_A = 'from-shell';
    try {
      expect(loadDotEnv(path)).toBe('loaded');
      expect(process.env.MCP_EVALS_TEST_A).toBe('from-shell');
      expect(process.env.MCP_EVALS_TEST_B).toBe('from-file');
    } finally {
      delete process.env.MCP_EVALS_TEST_A;
      delete process.env.MCP_EVALS_TEST_B;
    }
  });

  it('reports a missing file, and a Node without process.loadEnvFile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'env-'));
    expect(loadDotEnv(join(dir, '.env'))).toBe('missing');
    await writeFile(join(dir, '.env'), 'X=1\n');
    expect(loadDotEnv(join(dir, '.env'), null)).toBe('unsupported');
  });
});
