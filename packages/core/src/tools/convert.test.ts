import { describe, expect, it } from 'vitest';
import { convertTools, sanitizeToolName } from './convert.js';

describe('convertTools', () => {
  // Review Focus 1
  it('sanitizes illegal names and maps them back', () => {
    const m = convertTools([
      { name: 'github/search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'dotted.name', inputSchema: {} },
    ]);
    expect(m.defs.map((d) => d.name)).toEqual(['dotted_name', 'github_search']);
    expect(m.toMcpName('github_search')).toBe('github/search');
    expect(m.toMcpName('dotted_name')).toBe('dotted.name');
    expect(m.toMcpName('nope')).toBeUndefined();
    expect(m.defs[0]).toEqual({ name: 'dotted_name', description: '', parameters: { type: 'object', properties: {} } });
  });

  it('disambiguates collisions deterministically', () => {
    const m = convertTools([{ name: 'a.b', inputSchema: {} }, { name: 'a/b', inputSchema: {} }]);
    expect(m.defs.map((d) => d.name)).toEqual(['a_b', 'a_b_2']);
    expect(m.toMcpName('a_b')).toBe('a.b');
    expect(m.toMcpName('a_b_2')).toBe('a/b');
  });

  it('is order-independent (fairness)', () => {
    const tools = [{ name: 'b', inputSchema: {} }, { name: 'a', inputSchema: {} }];
    expect(convertTools(tools).defs).toEqual(convertTools([...tools].reverse()).defs);
  });

  it('truncates to 64 characters', () => {
    expect(sanitizeToolName('x'.repeat(80))).toHaveLength(64);
    expect(sanitizeToolName('')).toBe('tool');
  });
});
