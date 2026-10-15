// Fake MCP server for tests. Import buildFakeServer() for in-memory use,
// or run `node fake-server.mjs` to serve over stdio (crash tool enabled).
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function buildFakeServer(cwd = process.cwd(), opts = {}) {
  const server = new McpServer({ name: 'fake', version: '1.0.0' });
  server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async ({ text: t }) => text(t));
  server.registerTool('big', { description: 'Return size characters', inputSchema: { size: z.number().int().min(0) } }, async ({ size }) => text('x'.repeat(size)));
  server.registerTool('fail', { description: 'Always returns a tool error' }, async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
  server.registerTool('read_file', { description: 'Read a file relative to cwd', inputSchema: { path: z.string() } }, async ({ path }) => text(readFileSync(resolve(cwd, path), 'utf8')));
  server.registerTool('write_file', { description: 'Write a file relative to cwd', inputSchema: { path: z.string(), content: z.string() } }, async ({ path, content }) => {
    writeFileSync(resolve(cwd, path), content);
    return text('ok');
  });
  server.registerTool('slow', { description: 'Sleep then answer', inputSchema: { ms: z.number().int().min(0) } }, async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return text('done');
  });
  server.registerTool('shout', { description: 'Write text to stderr', inputSchema: { text: z.string() } }, async ({ text: t }) => {
    process.stderr.write(`${t}\n`);
    return text('shouted');
  });
  server.registerTool('dotted.name', { description: 'Tool whose name is illegal for model function names' }, async () => text('dotted'));
  if (opts.allowCrash) {
    server.registerTool('crash', { description: 'Exit the server process' }, async () => process.exit(1));
  }
  return server;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    // realpath both sides so launching through a symlink (or /var → /private/var on macOS) still matches.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  await buildFakeServer(process.cwd(), { allowCrash: true }).connect(new StdioServerTransport());
}
