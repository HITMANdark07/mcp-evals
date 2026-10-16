import { createHash } from 'node:crypto';
import type { JsonObject } from './types.js';

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

/** Backoff before retrying a transient provider error (429/5xx/network/timeout): 2 s, 10 s, then 30 s. */
export const PROVIDER_BACKOFF_MS: readonly number[] = [2_000, 10_000, 30_000];

export function providerBackoffMs(attempt: number): number {
  return PROVIDER_BACKOFF_MS[Math.min(Math.max(attempt, 1), PROVIDER_BACKOFF_MS.length) - 1]!;
}
