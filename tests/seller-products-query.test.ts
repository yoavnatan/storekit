import { describe, it, expect } from 'vitest';
import type { StoreProduct } from '../src/lib/store-products.js';
import { LOW_STOCK_THRESHOLD } from '../src/lib/store-products.js';
import {
  stockBucket,
  parseSellerProductQuery,
  filterAndSortSellerProducts,
  NO_CATEGORY_TOKEN,
} from '../src/lib/seller-products-query.js';
import { MIN_DESCRIPTION_LENGTH, needsSeoAttention, productSeoInputFrom } from '../src/lib/product-seo-hints.js';

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
      q: '', sortCol: 'name', sortDir: 'asc', categoryPaths: [], stockStatuses: statuses as ('out' | 'low' | 'ok')[], seoLevels: [],
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

// "ללא קטגוריה" is a real filter value, and its natural payload — the empty path an
// uncategorized product carries — is exactly what a list encoder drops. When that
// happened the filter reached the server empty and read as "no filter", so picking it
// appeared to do nothing at all.
describe('parseSellerProductQuery — pcat, uncategorized', () => {
  it('decodes the no-category token back to the empty path', () => {
    const q = parseSellerProductQuery(new URLSearchParams(`pcat=${NO_CATEGORY_TOKEN}`));
    expect(q.categoryPaths).toEqual(['']);
  });
  it('keeps it alongside real category paths', () => {
    const q = parseSellerProductQuery(new URLSearchParams(`pcat=${encodeURIComponent('ביגוד › חולצות')},${NO_CATEGORY_TOKEN}`));
    expect(q.categoryPaths).toEqual(['ביגוד › חולצות', '']);
  });
  it('stays empty when no category is selected', () => {
    expect(parseSellerProductQuery(new URLSearchParams('')).categoryPaths).toEqual([]);
  });
});

describe('filterAndSortSellerProducts — category filter', () => {
  const p = (id: string): StoreProduct =>
    ({ id, slug: id, name: id, price: 10, stock: 5, createdAt: '2026-01-01', sku: '' } as StoreProduct);
  const products = [p('shirt'), p('loose'), p('shoe')];
  const cats = new Map<string, string>([['shirt', 'ביגוד › חולצות'], ['shoe', 'הנעלה']]); // 'loose' has no category

  const run = (paths: string[]): string[] =>
    filterAndSortSellerProducts(products, cats, {}, {}, {
      q: '', sortCol: 'name', sortDir: 'asc', categoryPaths: paths, stockStatuses: [], seoLevels: [],
    }).map((x) => x.id);

  it('isolates the products that have no category', () => {
    expect(run([''])).toEqual(['loose']);
  });
  it('ORs "no category" with a real path', () => {
    expect(run(['הנעלה', '']).sort()).toEqual(['loose', 'shoe']);
  });
});

// Search-visibility filter — the discovery half of the products table's row gauge. Its whole value
// is that "weak" here selects exactly the rows that CARRY a gauge, so it is pinned against
// needsSeoAttention itself rather than against a restated rule.
describe('parseSellerProductQuery — pseo', () => {
  it('keeps only real bands and drops junk', () => {
    expect(parseSellerProductQuery(new URLSearchParams('pseo=weak,bogus,strong')).seoLevels).toEqual(['weak', 'strong']);
  });
  it('defaults to no visibility restriction', () => {
    expect(parseSellerProductQuery(new URLSearchParams('')).seoLevels).toEqual([]);
  });
});

describe('filterAndSortSellerProducts — search-visibility filter', () => {
  const full = 'ת'.repeat(MIN_DESCRIPTION_LENGTH);
  const base = { price: 10, stock: 5, createdAt: '2026-01-01', sku: '' };
  // strong: every hint satisfied. weak-noimage: everything BUT the photo — the case that proves
  // the band is not a count (4 of 5 and still weak, because it cannot be advertised).
  // weak-bare: name + price only, the shape a CSV import creates.
  const products = [
    { ...base, id: 'strong', slug: 'strong', name: 'שם מוצר ארוך דיו', description: full, images: ['a.jpg'], categoryId: 'c1', specs: [{ label: 'חומר', value: 'עץ' }, { label: 'מידה', value: 'L' }] },
    { ...base, id: 'weak-noimage', slug: 'weak-noimage', name: 'שם מוצר ארוך דיו', description: full, categoryId: 'c1', specs: [{ label: 'חומר', value: 'עץ' }, { label: 'מידה', value: 'L' }] },
    { ...base, id: 'weak-bare', slug: 'weak-bare', name: 'כיסא', description: '' },
  ] as unknown as StoreProduct[];
  const cats = new Map<string, string>();
  const run = (levels: string[]): string[] =>
    filterAndSortSellerProducts(products, cats, {}, {}, {
      q: '', sortCol: 'name', sortDir: 'asc', categoryPaths: [], stockStatuses: [],
      seoLevels: levels as ('weak' | 'partial' | 'strong')[],
    }).map((x) => x.id);

  it('returns everything when no band is selected', () => {
    expect(run([]).sort()).toEqual(['strong', 'weak-bare', 'weak-noimage']);
  });

  it('"weak" finds exactly the listings the row gauge marks', () => {
    const weak = products.filter((p) => needsSeoAttention(productSeoInputFrom(p))).map((p) => p.id);
    expect(run(['weak']).sort()).toEqual([...weak].sort());
    expect(run(['weak']).sort()).toEqual(['weak-bare', 'weak-noimage']);
  });

  it('a complete listing is not weak', () => {
    expect(run(['strong'])).toEqual(['strong']);
  });
});
