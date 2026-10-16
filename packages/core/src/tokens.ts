import { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';

/** Recorded in docs/methodology.md: the headline context metric is identical for every model. */
export const TOKENIZER = 'gpt-tokenizer o200k_base';

// Tool output may legitimately contain text such as "<|endoftext|>": count it as text, never throw.
const AS_TEXT = { disallowedSpecial: new Set<string>() };

/** Tokens in `text` under o200k_base. Depends only on the text, so it is comparable across servers and models. */
export function countTokens(text: string): number {
  return text.length === 0 ? 0 : countO200k(text, AS_TEXT);
}
