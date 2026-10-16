export type InfraKind = 'provider' | 'server' | 'setup' | 'fixture';

/** Thrown by ModelProvider implementations. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
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
  ) {
    super(message);
  }
}

/** Bad user input (flags, filters) detected before any spend. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** OpenRouter answered 402 (out of credits). Stops the whole run: no new runs, results so far kept, partial. */
export class OutOfCreditsError extends Error {
  override readonly name = 'OutOfCreditsError';
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
