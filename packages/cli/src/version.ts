import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves to packages/cli/package.json from both src/ and dist/.
export const CLI_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/**
 * `git rev-parse --short HEAD` of the harness checkout this CLI runs from, or null when it is not a git checkout
 * (an npm install inside node_modules would otherwise report the *user's* repository commit).
 */
export function harnessCommit(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.split(sep).includes('node_modules')) return null;
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: here,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // git needs nothing from the parent environment (and never sees the API key).
      env: { PATH: process.env.PATH ?? '', GIT_TERMINAL_PROMPT: '0' },
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
