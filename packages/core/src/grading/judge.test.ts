import { describe, expect, it, vi } from 'vitest';
import { InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatRequest, ChatResponse, ModelProvider } from '../types.js';
import { JUDGE_SYSTEM_PROMPT, runJudge } from './judge.js';

function scripted(replies: Array<string | Error>, costUsd = 0.0002) {
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    name: 'stub',
    chat: async (req): Promise<ChatResponse> => {
      requests.push(req);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { content: next ?? '', toolCalls: [], usage: { promptTokens: 50, completionTokens: 5, costUsd }, latencyMs: 1 };
    },
  };
  return { provider, requests };
}

const input = { taskPrompt: 'Which router is the default?', finalAnswer: 'SmartRouter', rubric: 'Names SmartRouter.' };

describe('runJudge', () => {
  it('sends the task, the answer and the rubric to the pinned judge, and returns its verdict and cost', async () => {
    const { provider, requests } = scripted(['{"pass": true, "score": 0.9, "reason": "correct"}']);
    const v = await runJudge({ provider, model: 'j/judge', providerPin: 'acme' }, input);
    expect(v).toEqual({ pass: true, detail: 'judge pass (score 0.9): correct', costUsd: 0.0002 });
    const [req] = requests;
    expect(req).toMatchObject({ model: 'j/judge', providerPin: 'acme', tools: [], temperature: 0 });
    expect(req!.messages[0]).toEqual({ role: 'system', content: JUDGE_SYSTEM_PROMPT });
    const user = req!.messages[1]!.content ?? '';
    expect(user).toContain('Which router is the default?');
    expect(user).toContain('SmartRouter');
    expect(user).toContain('Names SmartRouter.');
  });

  it('reads fenced verdicts, and fails unparseable ones with the reason', async () => {
    const fenced = scripted(['```json\n{"pass": false, "reason": "wrong router"}\n```']);
    expect(await runJudge({ provider: fenced.provider, model: 'j' }, input)).toMatchObject({ pass: false, detail: 'judge fail: wrong router' });
    const junk = scripted(['I think it passes']);
    expect(await runJudge({ provider: junk.provider, model: 'j' }, input)).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/^unparseable judge verdict/),
      costUsd: 0.0002,
    });
  });

  it('applies pass_threshold to the score', async () => {
    const low = scripted(['{"pass": true, "score": 0.4, "reason": "partly"}']);
    expect(await runJudge({ provider: low.provider, model: 'j' }, { ...input, passThreshold: 0.5 })).toMatchObject({ pass: false });
    const none = scripted(['{"pass": true, "reason": "no score"}']);
    expect(await runJudge({ provider: none.provider, model: 'j' }, { ...input, passThreshold: 0.5 })).toMatchObject({
      pass: false,
      detail: expect.stringMatching(/no score/),
    });
  });

  it('retries retryable provider errors with backoff, then gives up with a non-retryable InfraError', async () => {
    const sleep = vi.fn(async () => {});
    const flaky = scripted([new ProviderError('429', true, 429), '{"pass": true, "reason": "ok"}']);
    expect(await runJudge({ provider: flaky.provider, model: 'j', sleep }, input)).toMatchObject({ pass: true });
    expect(sleep).toHaveBeenCalledWith(500);

    const down = scripted([new ProviderError('503', true, 503), new ProviderError('503', true, 503), new ProviderError('503', true, 503)]);
    const err = await runJudge({ provider: down.provider, model: 'j', sleep, retries: 2 }, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InfraError);
    expect(err).toMatchObject({ kind: 'provider', retryable: false });
    expect(down.requests).toHaveLength(3);

    const denied = scripted([new ProviderError('401', false, 401)]);
    await expect(runJudge({ provider: denied.provider, model: 'j', sleep }, input)).rejects.toMatchObject({ kind: 'provider', retryable: false });
    expect(denied.requests).toHaveLength(1);
  });

  it('lets OutOfCreditsError through so the runner can stop the whole run', async () => {
    const broke = scripted([new OutOfCreditsError('402')]);
    await expect(runJudge({ provider: broke.provider, model: 'j' }, input)).rejects.toBeInstanceOf(OutOfCreditsError);
  });

  it('rejects out-of-range scores and rethrows unexpected errors unchanged', async () => {
    for (const score of [5, -1]) {
      const s = scripted([`{"pass": true, "score": ${score}, "reason": "x"}`]);
      expect(await runJudge({ provider: s.provider, model: 'j' }, input)).toMatchObject({ pass: false, detail: expect.stringMatching(/score must be a number between 0 and 1/) });
    }
    const bug = new Error('bug');
    const b = scripted([bug]);
    await expect(runJudge({ provider: b.provider, model: 'j' }, input)).rejects.toBe(bug);
  });
});
