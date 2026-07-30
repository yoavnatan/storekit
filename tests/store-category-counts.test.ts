import { describe, it, expect } from 'vitest';
import { countProductsPerCategory, type StoreCategory } from '../src/lib/store-categories.js';

function cat(id: string, parentId: string | null): StoreCategory {
  return { id, storeId: 's1', name: id, parentId, order: 0, createdAt: '' };
}

// ביגוד › גברים › חולצות, plus a sibling root.
const CATEGORIES: StoreCategory[] = [
  cat('clothing', null),
  cat('men', 'clothing'),
  cat('shirts', 'men'),
  cat('home', null),
];

describe('countProductsPerCategory', () => {
  it('counts a product for its own category and every ancestor', () => {
    const counts = countProductsPerCategory(CATEGORIES, ['shirts']);
    expect(counts).toEqual({ shirts: 1, men: 1, clothing: 1 });
  });

  it('matches what clicking the chip actually filters to', () => {
    // A parent chip filters its whole subtree, so its count must be the subtree's.
    const counts = countProductsPerCategory(CATEGORIES, ['shirts', 'men', 'clothing', 'home']);
    expect(counts.clothing).toBe(3);
    expect(counts.men).toBe(2);
    expect(counts.shirts).toBe(1);
    expect(counts.home).toBe(1);
  });

  it('leaves uncategorised products out entirely', () => {
    expect(countProductsPerCategory(CATEGORIES, [undefined, null, ''])).toEqual({});
  });

  it('ignores a product pointing at a deleted category', () => {
    expect(countProductsPerCategory(CATEGORIES, ['gone', 'home'])).toEqual({ home: 1 });
  });

  it('terminates on a malformed parent cycle', () => {
    const cyclic: StoreCategory[] = [cat('a', 'b'), cat('b', 'a')];
    expect(() => countProductsPerCategory(cyclic, ['a'])).not.toThrow();
  });
});
