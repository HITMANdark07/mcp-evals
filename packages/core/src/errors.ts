export type InfraKind = 'provider' | 'server' | 'setup' | 'fixture';

/** Thrown by ModelProvider implementations. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** Spend the failed call still incurred (an error body's usage.cost, or the estimate for an aborted request). */
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/** Infrastructure failure: never counted as a model failure. */
export class InfraError extends Error {
  override readonly name = 'InfraError';
  constructor(
    readonly kind: InfraKind,
    message: string,
    readonly retryable: boolean,
    /** Spend incurred by the failed work that is not counted anywhere else (e.g. failed judge attempts). */
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/** Bad user input (flags, filters) detected before any spend. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** OpenRouter answered 402 (out of credits) or 403 key/credit limit. Stops the whole run: no new runs, results so far kept, partial. */
export class OutOfCreditsError extends Error {
  override readonly name = 'OutOfCreditsError';
  constructor(
    message: string,
    readonly costUsd = 0,
  ) {
    super(message);
  }
}

/**
 * The spend of a model call could not be determined (no usage.cost and no way to price the call).
 * Not a ProviderError: it stops the whole run (resumable), because the budget cap can no longer be enforced.
 */
export class CostUnknownError extends Error {
  override readonly name = 'CostUnknownError';
  constructor(
    /** Precise cause, e.g. "usage.cost missing and no catalog price for acme/model-a". */
    readonly reason: string,
    /** Spend that is known despite the unknown part. */
    readonly costUsd = 0,
  ) {
    super(`cost could not be determined: ${reason}`);
  }
}

/** Spend carried by an error (see the `costUsd` fields above); 0 for anything else. */
export function spentUsd(e: unknown): number {
  const c = typeof e === 'object' && e !== null ? (e as { costUsd?: unknown }).costUsd : undefined;
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : 0;
}

/** One MCP tool call exceeded the per-call tool timeout. A model fail (end 'tool_timeout'), never infra. */
export class ToolTimeoutError extends Error {
  override readonly name = 'ToolTimeoutError';
  constructor(
    readonly tool: string,
    readonly timeoutMs: number,
  ) {
    super(`${tool}: tool call timed out after ${timeoutMs}ms`);
  }
}
