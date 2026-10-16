import { describe, expect, it } from 'vitest';
import { OutOfCreditsError, ProviderError, ToolTimeoutError } from './errors.js';

describe('M2 errors', () => {
  it('OutOfCreditsError is not a ProviderError, so nothing retries it or records it as a run error', () => {
    const e = new OutOfCreditsError('OpenRouter 402: Insufficient credits');
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ProviderError);
    expect(e.name).toBe('OutOfCreditsError');
  });

  it('ToolTimeoutError names the tool and the timeout', () => {
    expect(new ToolTimeoutError('read_file', 50)).toMatchObject({
      name: 'ToolTimeoutError',
      tool: 'read_file',
      timeoutMs: 50,
      message: 'read_file: tool call timed out after 50ms',
    });
  });
});
