// Local stand-in for OpenRouter, for offline tests only. Never point it at the real API.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeReply {
  status?: number;
  /** JSON body (default: an "ok" completion). */
  json?: unknown;
  /** Raw body, sent instead of `json` (for malformed responses). */
  raw?: string;
  /** Wait this long before answering. */
  delayMs?: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export interface FakeOpenRouter {
  /** Pass as `baseUrl`, e.g. http://127.0.0.1:41234/api/v1 */
  baseUrl: string;
  /** Every request received, in order. */
  requests: FakeRequest[];
  chatRequests(): FakeRequest[];
  /** Replies for POST /chat/completions, used first-in first-out before `respond`. */
  enqueue(...replies: FakeReply[]): void;
  close(): Promise<void>;
}

export interface FakeOpenRouterOptions {
  /** `data` for GET /models (default DEFAULT_CATALOG). */
  models?: unknown[];
  /** Answers chat requests when the queue is empty (default: an "ok" completion). */
  respond?: (body: any) => FakeReply;
}

export const DEFAULT_CATALOG = [
  { id: 'acme/model-a', supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'acme/judge', supported_parameters: ['temperature'], pricing: { prompt: '0.0000001', completion: '0.0000005' } },
  { id: 'acme/no-tools', supported_parameters: ['temperature'], pricing: { prompt: '0.000001', completion: '0.000002' } },
];

export function completion(
  message: { content?: string | null; tool_calls?: unknown[] },
  usage: Record<string, number> = { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
  provider = 'Acme',
): unknown {
  return {
    id: 'gen-test',
    provider,
    model: 'acme/model-a',
    choices: [{
      index: 0,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) },
    }],
    usage,
  };
}

export function toolCall(id: string, name: string, args: unknown): unknown {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

export async function startFakeOpenRouter(o: FakeOpenRouterOptions = {}): Promise<FakeOpenRouter> {
  const queue: FakeReply[] = [];
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: any;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ method: req.method ?? '', path, headers: req.headers, body });
      let reply: FakeReply;
      if (req.method === 'GET' && path === '/api/v1/models') reply = { json: { data: o.models ?? DEFAULT_CATALOG } };
      else if (req.method === 'POST' && path === '/api/v1/chat/completions') reply = queue.shift() ?? o.respond?.(body) ?? {};
      else reply = { status: 404, json: { error: { code: 404, message: `no route ${path}` } } };
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(reply.raw ?? JSON.stringify(reply.json ?? completion({ content: 'ok' })));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.path === '/api/v1/chat/completions'),
    enqueue: (...replies) => {
      queue.push(...replies);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
