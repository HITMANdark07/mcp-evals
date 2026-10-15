import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultsSchema } from '@mcp-evals/core';
import { describe, expect, it } from 'vitest';
import { runCommand } from './run.js';

const FAKE = fileURLToPath(new URL('../../../core/test/fixtures/fake-server.mjs', import.meta.url));

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'cli-run-'));
  const suite = join(dir, 'suite.yaml');
  await writeFile(
    suite,
    [
      'suite: e2e',
      'version: 1',
      'servers:',
      `  fake: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE)}] }`,
      'models: [mock/a]',
      'defaults: { repeats: 2, max_steps: 4, timeout_s: 20 }',
      'tasks:',
      '  - id: echo',
      '    prompt: "ECHO please"',
      '    graders: [{ type: tool_called, tool: echo }, { type: answer_contains_all, values: [hello] }]',
      '  - id: crash',
      '    prompt: "CRASH please"',
      '    graders: [{ type: tool_called, tool: crash }]',
    ].join('\n'),
  );
  const script = join(dir, 'script.json');
  await writeFile(
    script,
    JSON.stringify({
      entries: [
        { match: 'ECHO', steps: [{ toolCalls: [{ name: 'echo', arguments: { text: 'hello' } }] }, { content: 'hello' }] },
        { match: 'CRASH', steps: [{ toolCalls: [{ name: 'crash' }] }, { content: 'unreachable' }] },
      ],
    }),
  );
  return { dir, suite, script };
}

describe('runCommand (end-to-end over stdio, mock model)', () => {
  it('runs, writes valid results and traces, and prints a table', async () => {
    const { dir, suite, script } = await workspace();
    const lines: string[] = [];
    const { exitCode, results } = await runCommand({
      suites: [suite], provider: 'mock', mockScript: script,
      out: join(dir, 'out', 'results.json'), traces: join(dir, 'traces.jsonl'),
      cacheDir: join(dir, 'cache'), retries: 0, log: (l) => lines.push(l),
    });
    expect(exitCode).toBe(0);
    const written = ResultsSchema.parse(JSON.parse(await readFile(join(dir, 'out', 'results.json'), 'utf8')));
    expect(written).toEqual(results);
    const cell = written.suites[0]!.cells[0]!;
    expect(cell.runs).toBe(4);
    expect(cell.tasks).toEqual([
      expect.objectContaining({ id: 'echo', passes: 2, fails: 0, errors: 0 }),
      // Review Focus 3: a crashing server is an error, never a model fail
      expect.objectContaining({ id: 'crash', passes: 0, fails: 0, errors: 2 }),
    ]);
    expect(cell.errorRate).toBe(0.5);
    const traces = (await readFile(join(dir, 'traces.jsonl'), 'utf8')).trim().split('\n');
    expect(traces).toHaveLength(4);
    const trace = JSON.parse(traces[0]!);
    expect(trace).toHaveProperty('events');
    expect(trace).toMatchObject({ outcome: 'pass', end: 'final_answer', attempts: 1 });
    expect(trace.graders).toEqual([expect.objectContaining({ type: 'tool_called', pass: true }), expect.objectContaining({ type: 'answer_contains_all', pass: true })]);
    const crashTrace = traces.map((l) => JSON.parse(l)).find((t) => t.task === 'crash');
    expect(crashTrace).toMatchObject({ outcome: 'error', end: 'infra_error', failReason: expect.stringMatching(/server/) });
    expect(lines.some((l) => l.startsWith('SUITE'))).toBe(true);
  });

  it('exits 2 with a clear message for invalid suites and bad flags', async () => {
    const { dir, suite, script } = await workspace();
    const bad = join(dir, 'bad.yaml');
    await writeFile(bad, 'suite: x\nversion: 1\n');
    const lines: string[] = [];
    const base = { out: join(dir, 'r.json'), cacheDir: join(dir, 'c'), retries: 0, log: (l: string) => lines.push(l) };
    expect((await runCommand({ ...base, suites: [bad], provider: 'mock', mockScript: script })).exitCode).toBe(2);
    expect((await runCommand({ ...base, suites: [suite], provider: 'openrouter' })).exitCode).toBe(2);
    expect((await runCommand({ ...base, suites: [suite], provider: 'mock' })).exitCode).toBe(2);
    expect((await runCommand({ ...base, suites: [suite], provider: 'mock', mockScript: script, models: ['mock/typo'] })).exitCode).toBe(2);
    expect(lines.filter((l) => l.startsWith('error: '))).toHaveLength(4);
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
  });
});
