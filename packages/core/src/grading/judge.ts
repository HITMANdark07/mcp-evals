import { InfraError, OutOfCreditsError, ProviderError } from '../errors.js';
import type { ChatResponse, ModelProvider } from '../types.js';
import { isPlainObject, sleep as realSleep } from '../util.js';
import { extractJson } from './json-schema.js';

export const JUDGE_SYSTEM_PROMPT =
  'You grade answers produced by an AI agent. Judge only against the rubric. Be strict: vague answers and invented facts fail. ' +
  'Reply with only a JSON object: {"pass": boolean, "score": number between 0 and 1, "reason": string}.';

export interface JudgeConfig {
  provider: ModelProvider;
  model: string;
  providerPin?: string;
  /** Retries for retryable provider errors (default 3). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JudgeInput {
  taskPrompt: string;
  finalAnswer: string;
  rubric: string;
  passThreshold?: number;
}

export interface JudgeVerdict {
  pass: boolean;
  detail: string;
  costUsd: number;
}

export function judgePrompt(i: JudgeInput): string {
  return [
    'Task given to the agent:',
    '<task>',
    i.taskPrompt,
    '</task>',
    '',
    "The agent's final answer:",
    '<answer>',
    i.finalAnswer,
    '</answer>',
    '',
    'Rubric:',
    '<rubric>',
    i.rubric,
    '</rubric>',
    '',
    'Decide whether the answer satisfies the rubric. Reply with only the JSON object.',
  ].join('\n');
}

export async function runJudge(cfg: JudgeConfig, input: JudgeInput): Promise<JudgeVerdict> {
  const retries = cfg.retries ?? 3;
  const sleep = cfg.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    let res: ChatResponse;
    try {
      res = await cfg.provider.chat({
        model: cfg.model,
        ...(cfg.providerPin !== undefined ? { providerPin: cfg.providerPin } : {}),
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: judgePrompt(input) },
        ],
        tools: [],
        temperature: 0,
      });
    } catch (e) {
      if (e instanceof OutOfCreditsError) throw e;
      if (!(e instanceof ProviderError)) throw e;
      if (e.retryable && attempt <= retries) {
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      // Not retryable by the runner either: re-running the agent would pay for it twice.
      throw new InfraError('provider', `judge ${cfg.model}: ${e.message}`, false);
    }
    return { ...parseVerdict(res.content ?? '', input.passThreshold), costUsd: res.usage.costUsd };
  }
}

function parseVerdict(text: string, threshold: number | undefined): { pass: boolean; detail: string } {
  const unparseable = { pass: false, detail: `unparseable judge verdict: ${JSON.stringify(text.slice(0, 200))}` };
  const parsed = extractJson(text);
  if (!parsed.ok || !isPlainObject(parsed.value)) return unparseable;
  const { pass, reason, score } = parsed.value;
  if (typeof pass !== 'boolean') return unparseable;
  const why = typeof reason === 'string' ? reason : '(no reason given)';
  if (score !== undefined && !(typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1)) {
    return { pass: false, detail: `unparseable judge verdict: score must be a number between 0 and 1, got ${JSON.stringify(score)}` };
  }
  const s = score;
  if (threshold !== undefined) {
    if (s === undefined) return { pass: false, detail: `judge gave no score (pass_threshold ${threshold}): ${why}` };
    return { pass: s >= threshold, detail: `judge score ${s} ${s >= threshold ? '>=' : '<'} ${threshold}: ${why}` };
  }
  return { pass, detail: `judge ${pass ? 'pass' : 'fail'}${s !== undefined ? ` (score ${s})` : ''}: ${why}` };
}
