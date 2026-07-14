import { describe, expect, it } from 'vitest';
import { truncateStack } from '../src/lib/error-log.js';

describe('truncateStack', () => {
  it('returns short stacks unchanged', () => {
    expect(truncateStack('short stack', 2000)).toBe('short stack');
  });

  it('truncates a stack longer than the max and appends an ellipsis', () => {
    const long = 'a'.repeat(50);
    const result = truncateStack(long, 10);
    expect(result).toBe('a'.repeat(10) + '…');
    expect(result.length).toBe(11);
  });
});
