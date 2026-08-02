/**
 * The pure half of `store-products.ts` — the parts that decide something about a product record
 * already in hand, with no storage behind them.
 *
 * Everything that reads or writes moved to `store-products-db.test.ts` when the module moved to
 * Postgres (DB_MIGRATION_PLAN.md §8 stage 2). Split rather than merged: these need no database,
 * they run in microseconds, and keeping them here is what makes it visible that the suite covers
 * the visibility rule and the stock-bucket rule as RULES — not only as side effects of a query
 * that happened to return the right row.
 */
import { describe, expect, it } from 'vitest';
import type { StoreProduct } from '../src/lib/store-products.js';
import { getEffectiveStock, isProductVisible, slugify, toPublicProduct } from '../src/lib/store-products.js';

function product(over: Partial<StoreProduct> = {}): StoreProduct {
  return { id: 'x', storeId: 's1', slug: 'x', name: 'X', description: '', price: 1, stock: 1, createdAt: '', ...over };
}

// This is a Hebrew marketplace and its sellers are not required to know English. Under the old
// `[^a-z0-9-]` strip a Hebrew name slugified to '', so EVERY Hebrew-named product in a store fell
// back to the same base and got a counter — /store/product, /store/product-2, /store/product-3 —
// throwing away the strongest keyword the URL can carry, for most of the catalogue.
describe('slugify', () => {
  it('keeps a Hebrew name as the slug instead of collapsing it to nothing', () => {
    expect(slugify('חולצה כחולה')).toBe('חולצה-כחולה');
  });

  it('gives two different Hebrew products two different slugs', () => {
    expect(slugify('שמלת ערב')).not.toBe(slugify('נעלי ספורט'));
  });

  it('still lowercases and hyphenates a Latin name exactly as before', () => {
    expect(slugify('Blue Shirt')).toBe('blue-shirt');
  });

  it('keeps digits and mixed scripts', () => {
    expect(slugify('חולצה Nike 42')).toBe('חולצה-nike-42');
  });

  it('drops everything a path must not carry — separators, punctuation, invisible marks', () => {
    expect(slugify('a/b?c#d%e.f')).toBe('abcdef');
    expect(slugify(`שמלה${String.fromCharCode(0x200f)}`)).toBe('שמלה'); // RTL mark from a paste
    expect(slugify(`שמלה${String.fromCharCode(0x0b)}`)).toBe('שמלה');   // control char
  });

  it('collapses and trims runs of hyphens rather than emitting them', () => {
    expect(slugify('  חולצה   ---  כחולה  ')).toBe('חולצה-כחולה');
    expect(slugify('!!!')).toBe(''); // caller falls back to 'product'
  });
});

describe('isProductVisible', () => {
  it('is visible for a plain product', () => {
    expect(isProductVisible(product())).toBe(true);
  });

  it('is hidden for an admin-blocked product', () => {
    expect(isProductVisible(product({ blocked: true }))).toBe(false);
  });

  it('is hidden for a seller-hidden product (the take-down switch)', () => {
    expect(isProductVisible(product({ hidden: true }))).toBe(false);
  });
});

describe('getEffectiveStock', () => {
  const variant = product({
    stock: 3,
    variants: [{ name: 'Size', options: ['S', 'M'] }],
    variantStock: { 'Size=S': 2 },
  });

  it('reads the flat stock field for a non-variant product', () => {
    expect(getEffectiveStock(product({ stock: 5 }))).toBe(5);
  });

  it('reads the variantStock override for a selected combo that has one', () => {
    expect(getEffectiveStock(variant, { Size: 'S' })).toBe(2);
  });

  // The partial-map rule the schema had to change to preserve (migration 0003): a combo with no
  // entry is not sold out, it sells from the shared pool.
  it('falls back to the shared stock pool for a combo with no override', () => {
    expect(getEffectiveStock(variant, { Size: 'M' })).toBe(3);
  });
});

describe('toPublicProduct', () => {
  it('drops the seller-only note and keeps everything a shopper may see', () => {
    const pub = toPublicProduct(product({ sellerNote: 'private', tags: ['t'] }));
    expect('sellerNote' in pub).toBe(false);
    expect(pub.tags).toEqual(['t']);
  });
});
