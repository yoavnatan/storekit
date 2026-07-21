import { describe, it, expect } from 'vitest';
import type { StoreProduct } from '../src/lib/store-products.js';
import { LOW_STOCK_THRESHOLD } from '../src/lib/store-products.js';
import {
  stockBucket,
  parseSellerProductQuery,
  filterAndSortSellerProducts,
} from '../src/lib/seller-products-query.js';

// Stock-status filter (CURRENT_TASK.md item 3). The boundary around
// LOW_STOCK_THRESHOLD is the only place a wrong `<` vs `<=` silently mislabels
// inventory, so pin it.
describe('stockBucket', () => {
  it('buckets 0 as out of stock', () => {
    expect(stockBucket(0)).toBe('out');
    expect(stockBucket(-5)).toBe('out'); // defensive: negative reads as out too
  });
  it('buckets 1..threshold as low', () => {
    expect(stockBucket(1)).toBe('low');
    expect(stockBucket(LOW_STOCK_THRESHOLD)).toBe('low'); // inclusive top of "low"
  });
  it('buckets above the threshold as ok', () => {
    expect(stockBucket(LOW_STOCK_THRESHOLD + 1)).toBe('ok');
    expect(stockBucket(999)).toBe('ok');
  });
});

describe('parseSellerProductQuery — pstock', () => {
  it('keeps only valid stock statuses and drops junk', () => {
    const q = parseSellerProductQuery(new URLSearchParams('pstock=out,low,bogus,ok'));
    expect(q.stockStatuses).toEqual(['out', 'low', 'ok']);
  });
  it('defaults to no stock restriction', () => {
    expect(parseSellerProductQuery(new URLSearchParams('')).stockStatuses).toEqual([]);
  });
});

describe('filterAndSortSellerProducts — stock filter', () => {
  const p = (id: string, stock: number): StoreProduct =>
    ({ id, slug: id, name: id, price: 10, stock, createdAt: '2026-01-01', sku: '' } as StoreProduct);
  const products = [p('out', 0), p('low', LOW_STOCK_THRESHOLD), p('ok', LOW_STOCK_THRESHOLD + 5)];
  const cats = new Map<string, string>();

  const run = (statuses: string[]): string[] =>
    filterAndSortSellerProducts(products, cats, {}, {}, {
      q: '', sortCol: 'name', sortDir: 'asc', categoryPaths: [], stockStatuses: statuses as ('out' | 'low' | 'ok')[],
    }).map((x) => x.id);

  it('returns everything when no status is selected', () => {
    expect(run([]).sort()).toEqual(['low', 'ok', 'out']);
  });
  it('isolates just the problem inventory (out + low)', () => {
    expect(run(['out', 'low']).sort()).toEqual(['low', 'out']);
  });
  it('matches a single status', () => {
    expect(run(['out'])).toEqual(['out']);
  });
});
