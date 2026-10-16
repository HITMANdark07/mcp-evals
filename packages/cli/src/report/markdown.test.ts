import { describe, expect, it } from 'vitest';
import { cell, results } from '../testing/results-fixture.js';
import { formatMarkdown } from './markdown.js';

describe('formatMarkdown', () => {
  it('renders a heading, pins, versions, one row per cell, and incomplete cells', () => {
    const r = results([cell({ server: 'neatcode', model: 'acme/a' }), cell({ server: 'filesystem', model: 'acme/a', runs: 3, complete: false })], {
      partial: true,
    });
    const lines = formatMarkdown(r).split('\n');
    expect(lines[0]).toBe('## mcp-evals results — run `run-1`');
    expect(lines).toContain('Harness 0.0.0 · 2026-10-16T00:00:00.000Z → 2026-10-16T00:10:00.000Z · total cost $0.0400 · **PARTIAL**');
    expect(lines).toContain('### code-navigation (v1)');
    expect(lines).toContain('Fixture: https://github.com/honojs/hono @ `08a023cbfde55b434fb0fb30fae35d42e4bf20aa`');
    expect(lines).toContain('Models: acme/a (acme)');
    expect(lines).toContain('Servers: neatcode 0.1.4, filesystem');
    expect(lines).toContain('| neatcode | acme/a | 4/4 | 75% | [30–95%] | – | 1000 | 5000 | 3.0 | $0.0100 | 0% |');
    expect(lines).toContain('| filesystem | acme/a | 3/4 | 75% | [30–95%] | – | 1000 | 5000 | 3.0 | $0.0100 | 0% |');
    expect(lines).toContain('Incomplete cells (not every planned run finished): filesystem/acme/a');
  });
});
