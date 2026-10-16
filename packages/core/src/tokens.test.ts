import { describe, expect, it } from 'vitest';
import { countTokens, TOKENIZER } from './tokens.js';

describe('countTokens (o200k_base)', () => {
  it('counts with the o200k_base encoding', () => {
    expect(TOKENIZER).toBe('gpt-tokenizer o200k_base');
    expect(countTokens('')).toBe(0);
    expect(countTokens('hello')).toBe(1);
    expect(countTokens('Hello, world!')).toBe(4);
    expect(countTokens('x'.repeat(40))).toBe(5);
  });

  it('counts special-token text as plain text instead of throwing', () => {
    expect(() => countTokens('a <|endoftext|> b')).not.toThrow();
    expect(countTokens('a <|endoftext|> b')).toBe(9);
  });
});
