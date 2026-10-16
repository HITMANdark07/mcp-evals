import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { InfraError, ToolTimeoutError } from '../errors.js';
import type { ConnectContext, Connector, JsonObject, McpConnection, McpTool } from '../types.js';
import { substituteVars } from '../util.js';

const STDERR_LIMIT = 64 * 1024;
const CLIENT_INFO = { name: 'mcp-evals', version: '0.0.0' };

export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: unknown) => {
      const item = c as { type?: unknown; text?: unknown };
      return item && item.type === 'text' && typeof item.text === 'string' ? item.text : JSON.stringify(c);
    })
    .join('\n');
}

function wrap(client: Client, getStderr: () => string): McpConnection {
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as JsonObject });
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, timeoutMs) {
      try {
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
        return { text: contentToText((res as { content?: unknown }).content), isError: (res as { isError?: unknown }).isError === true };
      } catch (e) {
        if (e instanceof McpError && e.code === ErrorCode.ConnectionClosed) {
          throw new InfraError('server', `${name}: server connection closed (crashed?): ${e.message}`, true);
        }
        if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) throw new ToolTimeoutError(name, timeoutMs);
        if (e instanceof McpError) return { text: `Error: ${e.message}`, isError: true };
        // Only a closed connection is known to be transient; anything else would most likely repeat on a retry.
        throw new InfraError('server', `${name}: ${(e as Error).message}`, false);
      }
    },
    stderr: getStderr,
    serverVersion: () => client.getServerVersion()?.version,
    async close() {
      try {
        await client.close();
      } catch {
        // already closed
      }
    },
  };
}

export const stdioConnector: Connector = async (server, ctx) => {
  if (server.command === undefined) {
    throw new InfraError('server', 'remote (url) servers are not supported until M2; use a command', false);
  }
  const sub = (s: string) => substituteVars(s, ctx.vars);
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(server.env)) env[k] = sub(v);
  const transport = new StdioClientTransport({
    command: sub(server.command),
    args: server.args.map(sub),
    cwd: ctx.cwd,
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8').slice(0, STDERR_LIMIT - stderr.length);
  });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close().catch(() => {});
    // A missing or non-executable command will not start on retry either.
    const code = (e as NodeJS.ErrnoException).code;
    const permanent = code === 'ENOENT' || code === 'EACCES';
    throw new InfraError('server', `failed to start ${server.command}: ${(e as Error).message}\n${stderr}`, !permanent);
  }
  return wrap(client, () => stderr);
};

export function createInMemoryConnector(build: (ctx: ConnectContext) => McpServer): Connector {
  return async (_server, ctx) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpServer = build(ctx);
    await mcpServer.connect(serverTransport);
    const client = new Client(CLIENT_INFO);
    await client.connect(clientTransport);
    const conn = wrap(client, () => '');
    return {
      ...conn,
      async close() {
        await conn.close();
        await mcpServer.close().catch(() => {});
      },
    };
  };
}
