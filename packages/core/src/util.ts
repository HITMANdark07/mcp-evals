import { createHash } from 'node:crypto';
import type { JsonObject } from './types.js';

/** M1 token estimate; replaced by a real tokenizer in M2. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export function runKey(parts: { suite: string; server: string; model: string; task: string; repeat: number }): string {
  return createHash('sha256')
    .update([parts.suite, parts.server, parts.model, parts.task, String(parts.repeat)].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Replaces `{name}` for every name present in `vars`; leaves others untouched. */
export function substituteVars(s: string, vars: Record<string, string>): string {
  return s.replace(/\{([a-z_]+)\}/g, (match, name: string) => vars[name] ?? match);
}

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
