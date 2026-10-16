import { describe, expect, it } from 'vitest';
import { main, type ProgramDeps } from './program.js';

function stub() {
  const calls: Array<[string, unknown]> = [];
  const err: string[] = [];
  const deps: ProgramDeps = {
    run: async (o) => (calls.push(['run', o]), { exitCode: 0 }),
    compare: async (o) => (calls.push(['compare', o]), { exitCode: 1 }),
    report: async (o) => (calls.push(['report', o]), { exitCode: 0 }),
    writeOut: () => {},
    writeErr: (s) => {
      err.push(s);
    },
  };
  return { calls, err, deps };
}

describe('main', () => {
  it('defaults run to the openrouter provider and the standard paths', async () => {
    const { calls, deps } = stub();
    expect(await main(['run', 'a.yaml'], deps)).toBe(0);
    expect(calls).toEqual([['run', { suites: ['a.yaml'], provider: 'openrouter', out: 'results.json', cacheDir: '.mcp-evals/cache', runsDir: '.mcp-evals/runs' }]]);
  });

  it('parses every run flag', async () => {
    const { calls, deps } = stub();
    const argv = [
      'run', 'a.yaml', 'b.yaml', '--provider', 'mock', '--mock-script', 'm.json', '--models', 'x/a, x/b', '--servers', 'fs', '--tasks', 't1,t2',
      '--repeats', '2', '--budget-usd', '9.5', '--resume', 'r1', '--yes', '--estimate-from', 'smoke.json', '--out', 'o.json', '--traces', 't.jsonl',
    ];
    expect(await main(argv, deps)).toBe(0);
    expect(calls[0]![1]).toEqual({
      suites: ['a.yaml', 'b.yaml'], provider: 'mock', mockScript: 'm.json', models: ['x/a', 'x/b'], servers: ['fs'], tasks: ['t1', 't2'],
      repeats: 2, budgetUsd: 9.5, resume: 'r1', yes: true, estimateFrom: 'smoke.json', out: 'o.json', traces: 't.jsonl',
      cacheDir: '.mcp-evals/cache', runsDir: '.mcp-evals/runs',
    });
  });

  it('returns the command exit code (compare regression → 1) with compare defaults', async () => {
    const { calls, deps } = stub();
    expect(await main(['compare', 'a.json', 'b.json'], deps)).toBe(1);
    expect(calls[0]).toEqual(['compare', { base: 'a.json', head: 'b.json', maxSuccessDrop: 5, maxContextIncrease: 20, format: 'table' }]);
    expect(await main(['report', 'r.json', '--format', 'markdown'], deps)).toBe(0);
    expect(calls[1]).toEqual(['report', { results: 'r.json', format: 'markdown' }]);
  });

  it('exits 2 on every usage error without running anything', async () => {
    const cases = [
      ['run', 'a.yaml', '--repeats', '0'],
      ['run', 'a.yaml', '--budget-usd', 'lots'],
      ['run'],
      ['run', 'a.yaml', '--provider', 'nope'],
      ['run', 'a.yaml', '--bogus'],
      ['compare', 'a.json'],
      ['compare', 'a.json', 'b.json', '--format', 'xml'],
      ['compare', 'a.json', 'b.json', '--max-success-drop', 'abc'],
      ['report', 'r.json', '--format', 'json'],
      ['bogus'],
      [],
    ];
    for (const argv of cases) {
      const { calls, err, deps } = stub();
      expect(await main(argv, deps)).toBe(2);
      expect(calls).toEqual([]);
      expect(err.join('')).not.toBe('');
    }
  });

  it('exits 0 for --help and --version', async () => {
    expect(await main(['--help'], stub().deps)).toBe(0);
    expect(await main(['--version'], stub().deps)).toBe(0);
  });
});
