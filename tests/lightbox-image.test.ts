import { describe, it, expect } from 'vitest';
import { neighbourIndexes } from '../src/lib/lightbox-image.js';

describe('neighbourIndexes', () => {
  it('returns nothing when there is nowhere to navigate', () => {
    expect(neighbourIndexes(0, 0)).toEqual([]);
    expect(neighbourIndexes(1, 0)).toEqual([]);
  });

  it('de-duplicates when both arrows land on the same image', () => {
    // Two images: next and previous are the SAME one. Without the dedup this
    // would queue an identical URL twice on every settle.
    expect(neighbourIndexes(2, 0)).toEqual([1]);
    expect(neighbourIndexes(2, 1)).toEqual([0]);
  });

  it('offers next before previous — forward is the direction people go', () => {
    expect(neighbourIndexes(4, 1)).toEqual([2, 0]);
  });

  it('wraps around both ends', () => {
    expect(neighbourIndexes(4, 3)).toEqual([0, 2]);
    expect(neighbourIndexes(4, 0)).toEqual([1, 3]);
  });

  it('stays O(1) regardless of gallery size — never the whole gallery', () => {
    expect(neighbourIndexes(20, 7)).toHaveLength(2);
    expect(neighbourIndexes(200, 0)).toHaveLength(2);
  });
});
