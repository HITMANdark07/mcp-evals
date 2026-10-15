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
