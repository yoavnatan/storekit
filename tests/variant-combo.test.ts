import { describe, expect, it } from 'vitest';
import { isProductInStock, evenSplit, resolveVariantStockMap, comboKey } from '../src/lib/variant-combo.js';

describe('isProductInStock', () => {
  it('for a non-variant product, reflects the flat stock field directly', () => {
    expect(isProductInStock(5, undefined, undefined)).toBe(true);
    expect(isProductInStock(0, undefined, undefined)).toBe(false);
  });

  it('is in stock when the shared pool covers a combo with no variantStock override', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(3, variants, {})).toBe(true);
  });

  it('is out of stock when the shared pool is empty and no combo has an override', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(0, variants, undefined)).toBe(false);
  });

  it('is in stock when the shared pool is empty but an overridden combo still has stock', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(0, variants, { 'Size=M': 4 })).toBe(true);
  });

  it('is out of stock when every combo is explicitly zeroed, even though the (now-unused) shared pool is nonzero', () => {
    const variants = [{ name: 'Size', options: ['S', 'M'] }];
    expect(isProductInStock(5, variants, { 'Size=S': 0, 'Size=M': 0 })).toBe(false);
  });
});

describe('evenSplit', () => {
  it('splits evenly with the remainder going to the first rows', () => {
    expect(evenSplit(3, 10)).toEqual([4, 3, 3]);
    expect(evenSplit(2, 10)).toEqual([5, 5]);
    expect(evenSplit(4, 2)).toEqual([1, 1, 0, 0]);
  });
  it('handles zero rows and zero total', () => {
    expect(evenSplit(0, 10)).toEqual([]);
    expect(evenSplit(3, 0)).toEqual([0, 0, 0]);
  });
});

describe('resolveVariantStockMap — inline per-combo stock persistence', () => {
  const variants = [{ name: 'Size', options: ['S', 'M'] }];

  it('converts a shared pool (no overrides) into an explicit even-split map', () => {
    // Shared pool of 10 → the same numbers the breakdown dropdown displays.
    expect(resolveVariantStockMap(variants, undefined, 10)).toEqual({ 'Size=S': 5, 'Size=M': 5 });
  });

  it('keeps existing overrides and zero-fills combos with no entry once any override exists', () => {
    expect(resolveVariantStockMap(variants, { 'Size=M': 4 }, 99)).toEqual({ 'Size=S': 0, 'Size=M': 4 });
  });

  it('drops stale keys for combos that no longer exist and covers every current combo', () => {
    const map = resolveVariantStockMap(variants, { 'Size=S': 7, 'Color=Red': 3 }, 0);
    expect(Object.keys(map).sort()).toEqual(['Size=M', 'Size=S']);
    expect(map['Size=S']).toBe(7);
  });

  it('sums to the intended total after editing one combo (the server total)', () => {
    // Edit "M" to 8 starting from a shared pool of 10 → {S:5, M:8}, total 13.
    const map = resolveVariantStockMap(variants, undefined, 10);
    map[comboKey({ Size: 'M' })] = 8;
    expect(Object.values(map).reduce((s, n) => s + n, 0)).toBe(13);
  });
});
