import { describe, expect, it } from 'vitest';
import { isProductInStock } from '../src/lib/variant-combo.js';

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
