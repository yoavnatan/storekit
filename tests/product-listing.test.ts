import { describe, it, expect } from 'vitest';
import { filterAndSortProducts } from '../src/lib/product-listing.js';
import type { StoreProduct } from '../src/lib/store-products.js';

const NOW = 1_700_000_000_000; // fixed epoch so the "new" recency window is deterministic
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

// Minimal fixture — only the fields the default ranking reads. Cast is fine: the ranking
// never touches the rest, and other sorts (name/price) aren't under test here.
function make(id: string, over: Partial<StoreProduct>): StoreProduct {
  return {
    id, name: id, price: 100, stock: 5, createdAt: daysAgo(100), images: [], storeId: 's1',
    ...over,
  } as StoreProduct;
}

const ids = (ps: StoreProduct[]) => ps.map((p) => p.id);

function rank(products: StoreProduct[], units: Record<string, number> = {}): StoreProduct[] {
  return filterAndSortProducts(products, { sort: 'default', purchasedUnits: units, nowMs: NOW });
}

describe('default product ranking', () => {
  it('ranks buyable products above sold-out ones — even a sold-out bestseller sinks below an in-stock standard item', () => {
    const products = [
      make('soldout-best', { stock: 0, createdAt: daysAgo(100) }), // 30 units but unavailable
      make('instock-standard', { stock: 5, createdAt: daysAgo(100) }),
    ];
    expect(ids(rank(products, { 'soldout-best': 30 }))).toEqual(['instock-standard', 'soldout-best']);
  });

  it('orders in-stock products by proven demand: bestseller › popular › new › standard', () => {
    const products = [
      make('standard', { createdAt: daysAgo(100) }),
      make('new', { createdAt: daysAgo(5) }),
      make('popular', { createdAt: daysAgo(100) }),
      make('bestseller', { createdAt: daysAgo(100) }),
    ];
    const order = ids(rank(products, { bestseller: 15, popular: 5, new: 0, standard: 0 }));
    expect(order).toEqual(['bestseller', 'popular', 'new', 'standard']);
  });

  it('within the same tier, more units sold ranks first', () => {
    const products = [
      make('popular-lo', { createdAt: daysAgo(100) }),
      make('popular-hi', { createdAt: daysAgo(100) }),
    ];
    expect(ids(rank(products, { 'popular-lo': 4, 'popular-hi': 8 }))).toEqual(['popular-hi', 'popular-lo']);
  });

  it('breaks a full tie deterministically with newer-first (no manual product order exists)', () => {
    const products = [
      make('older', { createdAt: daysAgo(100) }),
      make('newer', { createdAt: daysAgo(60) }), // both > 30d → both "standard", 0 units
    ];
    expect(ids(rank(products))).toEqual(['newer', 'older']);
  });

  it('treats a product as in stock when only a variant combo has stock (shared pool is 0)', () => {
    const variantProduct = make('variant-instock', {
      stock: 0,
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { 'מידה=M': 4 }, // shared pool 0, but one combo has stock
      createdAt: daysAgo(100),
    });
    const soldOut = make('soldout', { stock: 0, createdAt: daysAgo(100) });
    expect(ids(rank([soldOut, variantProduct]))).toEqual(['variant-instock', 'soldout']);
  });
});
