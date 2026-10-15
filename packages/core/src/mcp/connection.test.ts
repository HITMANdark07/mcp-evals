import { existsSync } from 'node:fs';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { InfraError } from '../errors.js';
import type { ServerSpec } from '../types.js';
import { contentToText, createInMemoryConnector, stdioConnector } from './connection.js';
import { runSetup } from './setup.js';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-server.mjs', import.meta.url));
const stdioSpec: ServerSpec = { command: process.execPath, args: [FAKE], env: {}, headers: {} };
const memory = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function tmp() {
  return mkdtemp(join(tmpdir(), 'conn-'));
}

describe('in-memory connector', () => {
  it('lists tools and calls them', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    const names = (await conn.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['big', 'dotted.name', 'echo', 'fail', 'read_file', 'shout', 'slow', 'write_file']);
    expect(await conn.callTool('echo', { text: 'hi' }, 5000)).toEqual({ text: 'hi', isError: false });
    expect((await conn.callTool('big', { size: 100 }, 5000)).text).toHaveLength(100);
    expect(await conn.callTool('fail', {}, 5000)).toEqual({ text: 'boom', isError: true });
    await conn.close();
  });

  it('maps unknown tools and bad arguments to tool errors, not exceptions', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    expect((await conn.callTool('nope', {}, 5000)).isError).toBe(true);
    expect((await conn.callTool('echo', { text: 42 }, 5000)).isError).toBe(true);
    await conn.close();
  });

  it('turns tool timeouts into non-retryable InfraErrors', async () => {
    const conn = await memory(stdioSpec, { cwd: await tmp(), vars: {} });
    const err = await conn.callTool('slow', { ms: 500 }, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'server', retryable: false });
    await conn.close();
  });
});

describe('stdio connector', () => {
  it('spawns the server in ctx.cwd and captures stderr', async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, 'note.txt'), 'from cwd');
    const conn = await stdioConnector(stdioSpec, { cwd, vars: {} });
    expect((await conn.callTool('read_file', { path: 'note.txt' }, 5000)).text).toBe('from cwd');
    await conn.callTool('shout', { text: 'hello-stderr' }, 5000);
    await vi.waitFor(() => expect(conn.stderr()).toContain('hello-stderr'));
    await conn.close();
  });

  it('substitutes {vars} in args', async () => {
    const cwd = await tmp();
    const spec: ServerSpec = { ...stdioSpec, args: ['{fake}'] };
    const conn = await stdioConnector(spec, { cwd, vars: { fake: FAKE } });
    expect((await conn.callTool('echo', { text: 'ok' }, 5000)).text).toBe('ok');
    await conn.close();
  });

  // Review Focus 3
  it('turns a crashing server into a retryable InfraError', async () => {
    const conn = await stdioConnector(stdioSpec, { cwd: await tmp(), vars: {} });
    const err = await conn.callTool('crash', {}, 5000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'server', retryable: true });
    await conn.close();
  });

  it('fails clearly for a command that cannot start', async () => {
    const err = await stdioConnector({ ...stdioSpec, command: '/definitely/not/here' }, { cwd: await tmp(), vars: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'server', retryable: false });
  });

  it('starts the fake server through a symlinked path', async () => {
    const dir = await tmp();
    const link = join(dir, 'linked-fake-server.mjs');
    await symlink(FAKE, link);
    const conn = await stdioConnector({ ...stdioSpec, args: [link] }, { cwd: dir, vars: {} });
    expect((await conn.callTool('echo', { text: 'via link' }, 5000)).text).toBe('via link');
    await conn.close();
  });

  it('rejects url servers until M2', async () => {
    const err = await stdioConnector({ args: [], env: {}, headers: {}, url: 'https://x.test/mcp' }, { cwd: await tmp(), vars: {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: 'server', retryable: false });
  });
});

describe('contentToText', () => {
  it('joins text and stringifies other content', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x', mimeType: 'image/png' }])).toBe(
      'a\n{"type":"image","data":"x","mimeType":"image/png"}',
    );
    expect(contentToText(undefined)).toBe('');
  });
});

describe('runSetup', () => {
  it('runs in cwd and throws InfraError on failure', async () => {
    const cwd = await tmp();
    await runSetup('echo hi > setup.txt', cwd);
    expect(existsSync(join(cwd, 'setup.txt'))).toBe(true);
    const err = await runSetup('exit 3', cwd).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'setup', retryable: false });
  });
});
