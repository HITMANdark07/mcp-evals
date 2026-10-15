import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InfraError } from '../errors.js';

const execFileP = promisify(execFile);

export async function runSetup(command: string, cwd: string, timeoutMs = 120_000): Promise<void> {
  try {
    await execFileP('sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    const err = e as Error & { stderr?: string; code?: number | string };
    throw new InfraError('setup', `setup command failed (${err.code ?? 'unknown'}): ${command}\n${(err.stderr ?? '').slice(-2000)}`, false);
  }
}
