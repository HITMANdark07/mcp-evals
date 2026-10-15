import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import type { ChatMessage, ChatRequest } from '../types.js';
import { DEFAULT_MOCK_COST_USD, MockProvider, parseMockScript } from './mock.js';

const script = parseMockScript({
  entries: [
    { match: 'only for b', model: 'm/b', steps: [{ content: 'b answer' }] },
    {
      match: 'echo',
      steps: [
        { toolCalls: [{ name: 'echo', arguments: { text: 'hi' } }] },
        { toolCalls: [{ name: 'echo', arguments: 'not json' }], usage: { costUsd: 0.5 } },
        { content: 'done' },
      ],
    },
    { match: 'flaky', steps: [{ error: { message: 'rate limited', status: 429 } }] },
  ],
});

function req(prompt: string, assistantTurns = 0, model = 'm/a'): ChatRequest {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: prompt }];
  for (let i = 0; i < assistantTurns; i++) messages.push({ role: 'assistant', content: null, toolCalls: [] });
  return { model, messages, tools: [], temperature: 0 };
}

describe('MockProvider', () => {
  const p = new MockProvider(script);

  it('plays steps by assistant-turn count', async () => {
    const s0 = await p.chat(req('please echo'));
    expect(s0.toolCalls).toEqual([{ id: 'call_0_0', name: 'echo', arguments: '{"text":"hi"}' }]);
    expect(s0.usage.costUsd).toBe(DEFAULT_MOCK_COST_USD);
    const s1 = await p.chat(req('please echo', 1));
    expect(s1.toolCalls[0]!.arguments).toBe('not json');
    expect(s1.usage.costUsd).toBe(0.5);
    const s2 = await p.chat(req('please echo', 2));
    expect(s2).toMatchObject({ content: 'done', toolCalls: [] });
    expect((await p.chat(req('please echo', 3))).content).toBe('(mock: script exhausted)');
  });

  it('respects model filters and falls back when nothing matches', async () => {
    expect((await p.chat(req('only for b', 0, 'm/b'))).content).toBe('b answer');
    expect((await p.chat(req('only for b', 0, 'm/a'))).content).toBe('(mock: no script entry matches)');
  });

  it('throws ProviderError for error steps (retryable by default)', async () => {
    const err = await p.chat(req('flaky')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true, status: 429 });
  });

  it('rejects malformed scripts', () => {
    expect(() => parseMockScript({ entries: [{ match: 'x', steps: [] }] })).toThrow();
  });
});
