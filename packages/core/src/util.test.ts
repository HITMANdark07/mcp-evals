import { describe, expect, it } from 'vitest';
import { estimateTokens, isPlainObject, mean, median, runKey, sha256Hex, substituteVars } from './util.js';

describe('estimateTokens', () => {
  it('is ceil(chars / 4) and 0 for empty', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcdefghi')).toBe(3);
  });
});

describe('runKey', () => {
  const base = { suite: 's', server: 'srv', model: 'a/b', task: 't', repeat: 0 };
  it('is a stable 16-char hex hash', () => {
    expect(runKey(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(runKey(base)).toBe(runKey({ ...base }));
  });
  it('differs when any part differs', () => {
    const keys = new Set([
      runKey(base),
      runKey({ ...base, suite: 's2' }),
      runKey({ ...base, server: 'x' }),
      runKey({ ...base, model: 'a/c' }),
      runKey({ ...base, task: 'u' }),
      runKey({ ...base, repeat: 1 }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe('mean / median', () => {
  it('handles empty, odd, and even inputs', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('substituteVars', () => {
  it('replaces known {vars} and leaves unknown ones', () => {
    expect(substituteVars('{fixture}/src {other}', { fixture: '/w' })).toBe('/w/src {other}');
  });
});

describe('isPlainObject / sha256Hex', () => {
  it('detects plain objects only', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
  });
  it('hashes strings and buffers identically', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
  });
});
