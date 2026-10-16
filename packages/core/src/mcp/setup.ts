import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InfraError } from '../errors.js';
import { substituteVars } from '../util.js';

const execFileP = promisify(execFile);

/**
 * The environment a server's setup command runs with: the MCP SDK's minimal default environment (PATH, HOME, …)
 * plus the server's own `env` with `{vars}` substituted — the same environment the server itself gets.
 * Never the full process environment, so OPENROUTER_API_KEY cannot leak into third-party setup code.
 */
export function setupEnv(serverEnv: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(serverEnv)) env[k] = substituteVars(v, vars);
  return env;
}

export async function runSetup(command: string, cwd: string, env: Record<string, string>, timeoutMs = 120_000): Promise<void> {
  try {
    await execFileP('sh', ['-c', command], { cwd, env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    const err = e as Error & { stderr?: string; code?: number | string };
    throw new InfraError('setup', `setup command failed (${err.code ?? 'unknown'}): ${command}\n${(err.stderr ?? '').slice(-2000)}`, false);
  }
}
