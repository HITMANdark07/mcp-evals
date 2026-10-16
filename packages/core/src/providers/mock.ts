import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ProviderError } from '../errors.js';
import type { ChatRequest, ChatResponse, ModelProvider, ToolCall } from '../types.js';
import { countTokens } from '../tokens.js';

const StepSchema = z
  .object({
    content: z.string().optional(),
    toolCalls: z
      .array(z.object({ name: z.string().min(1), arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).default({}) }).strict())
      .optional(),
    usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), costUsd: z.number() }).partial().optional(),
    error: z.object({ message: z.string(), retryable: z.boolean().default(true), status: z.number().optional() }).strict().optional(),
  })
  .strict();

const ScriptSchema = z
  .object({
    entries: z.array(z.object({ match: z.string(), model: z.string().optional(), steps: z.array(StepSchema).min(1) }).strict()),
  })
  .strict();

export type MockScript = z.infer<typeof ScriptSchema>;
type MockStep = z.infer<typeof StepSchema>;

export const DEFAULT_MOCK_COST_USD = 0.001;

export function parseMockScript(json: unknown): MockScript {
  return ScriptSchema.parse(json);
}

export async function loadMockScript(path: string): Promise<MockScript> {
  return parseMockScript(JSON.parse(await readFile(path, 'utf8')));
}

export class MockProvider implements ModelProvider {
  readonly name = 'mock';

  constructor(private readonly script: MockScript) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const prompt = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const step = req.messages.filter((m) => m.role === 'assistant').length;
    const promptTokens = countTokens(req.messages.map((m) => m.content ?? '').join('\n'));
    const entry = this.script.entries.find((e) => prompt.includes(e.match) && (e.model === undefined || e.model === req.model));
    if (!entry) return respond({ content: '(mock: no script entry matches)' }, promptTokens, step);
    const s = entry.steps[step];
    if (!s) return respond({ content: '(mock: script exhausted)' }, promptTokens, step);
    if (s.error) throw new ProviderError(s.error.message, s.error.retryable, s.error.status);
    return respond(s, promptTokens, step);
  }
}

function respond(s: MockStep, promptTokens: number, step: number): ChatResponse {
  const toolCalls: ToolCall[] = (s.toolCalls ?? []).map((c, i) => ({
    id: `call_${step}_${i}`,
    name: c.name,
    arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments),
  }));
  return {
    content: s.content ?? null,
    toolCalls,
    usage: {
      promptTokens: s.usage?.promptTokens ?? promptTokens,
      completionTokens: s.usage?.completionTokens ?? 10,
      costUsd: s.usage?.costUsd ?? DEFAULT_MOCK_COST_USD,
    },
    latencyMs: 1,
  };
}
