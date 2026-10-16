import { existsSync } from 'node:fs';

export type DotEnvStatus = 'loaded' | 'missing' | 'unsupported';
type Loader = (path: string) => void;

function nodeLoader(): Loader | null {
  return typeof process.loadEnvFile === 'function' ? (path) => process.loadEnvFile(path) : null;
}

/** Loads `.env` with Node's built-in loader. Variables already set in the environment win (Node never overrides them). */
export function loadDotEnv(path = '.env', load: Loader | null = nodeLoader()): DotEnvStatus {
  if (!existsSync(path)) return 'missing';
  if (load === null) return 'unsupported';
  load(path);
  return 'loaded';
}
