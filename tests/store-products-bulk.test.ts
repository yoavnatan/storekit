import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

let db: StoreProduct[] = [];
let categoriesDb: StoreCategory[] = [];

// bulkUpsertProducts also resolves each row's category through store-categories.ts, which reads/
// writes its own separate JSON file — the mock has to route by path or the two stores collide.
vi.mock('node:fs', () => ({
  default: {
    readFileSync: (path: string) => JSON.stringify(String(path).includes('store-categories') ? categoriesDb : db),
    writeFileSync: (path: string, data: string) => {
      if (String(path).includes('store-categories')) categoriesDb = JSON.parse(data);
      else db = JSON.parse(data);
    },
  },
}));

const { isSkuTaken } = await import('../src/lib/store-products.js');
const { bulkUpsertProducts, updateChangesProduct } = await import('../src/lib/store-products-bulk.js');

beforeEach(() => {
  categoriesDb = [
    { id: 'c1', storeId: 's1', name: 'Tools', parentId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  db = [
    { id: 'p1', storeId: 's1', slug: 'widget', name: 'Widget', description: '', price: 10, stock: 5, categoryId: 'c1', tags: ['sale'], sku: 'W-1', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'p2', storeId: 's2', slug: 'other-store-item', name: 'Other store item', description: '', price: 20, stock: 2, createdAt: '2026-01-01T00:00:00.000Z' },
  ];
});

describe('bulkUpsertProducts', () => {
  it('creates a new product with a fresh id/slug and default fields', async () => {
    const results = (await bulkUpsertProducts('s1', [{ name: 'Gadget', price: 30, stock: 7 }]));
    expect(results).toEqual([{ id: expect.any(String), action: 'create', product: expect.objectContaining({ name: 'Gadget' }) }]);
    const created = db.find((p) => p.id === results[0]!.id);
    expect(created).toMatchObject({ storeId: 's1', name: 'Gadget', price: 30, stock: 7, slug: 'gadget' });
  });

  it('defaults a create row with no stock cell to 0', async () => {
    const results = (await bulkUpsertProducts('s1', [{ name: 'Gadget', price: 30 }]));
    const created = db.find((p) => p.id === results[0]!.id);
    expect(created?.stock).toBe(0);
  });

  it('updates price/stock/name in place, preserving id/storeId/createdAt', async () => {
    const results = (await bulkUpsertProducts('s1', [{ id: 'p1', name: 'Widget Pro', price: 15, stock: 9 }]));
    expect(results).toEqual([{ id: 'p1', action: 'update', product: expect.objectContaining({ name: 'Widget Pro' }) }]);
    const updated = db.find((p) => p.id === 'p1')!;
    expect(updated).toMatchObject({ id: 'p1', storeId: 's1', createdAt: '2026-01-01T00:00:00.000Z', name: 'Widget Pro', price: 15, stock: 9 });
  });

  // Two imports landing at once — two dashboard tabs, or the feed sync beside a manual upload.
  // The catalog is still ONE JSON file rewritten whole, so an `await` between the read and the
  // write is where one of them silently disappears: both read the same snapshot, both report
  // success, and the second write erases the first's products. Reproduced at microtask
  // granularity, which is exactly what an awaited query yields. Retires with the file.
  it('does not lose a concurrently running import\'s products', async () => {
    await Promise.all([
      bulkUpsertProducts('s1', [{ name: 'A', price: 1, stock: 1 }]),
      bulkUpsertProducts('s1', [{ name: 'B', price: 2, stock: 2 }]),
    ]);
    expect(db.map((p) => p.name).sort()).toEqual(['A', 'B', 'Other store item', 'Widget']);
  });

  it('preserves stock/category/tags/sku when the update row omits them (blank CSV cell), instead of wiping them', async () => {
    (await bulkUpsertProducts('s1', [{ id: 'p1', name: 'Widget Renamed', price: 12 }]));
    const updated = db.find((p) => p.id === 'p1')!;
    expect(updated).toMatchObject({ name: 'Widget Renamed', price: 12, stock: 5, categoryId: 'c1', tags: ['sale'], sku: 'W-1' });
  });

  it('overwrites sku when the row explicitly provides one, and sets it on a fresh create', async () => {
    (await bulkUpsertProducts('s1', [{ id: 'p1', name: 'Widget', price: 12, sku: 'W-1-NEW' }]));
    expect(db.find((p) => p.id === 'p1')!.sku).toBe('W-1-NEW');

    const results = (await bulkUpsertProducts('s1', [{ name: 'Gadget', price: 5, sku: 'G-1' }]));
    expect(db.find((p) => p.id === results[0]!.id)!.sku).toBe('G-1');
  });

  it('does not touch a product belonging to a different store even if a matching id is passed', async () => {
    const results = (await bulkUpsertProducts('s1', [{ id: 'p2', name: 'Hijacked', price: 1, stock: 1 }]));
    expect(results).toEqual([{ id: 'p2', action: 'not-found' }]);
    expect(db.find((p) => p.id === 'p2')).toMatchObject({ name: 'Other store item', price: 20, stock: 2 });
  });

  it('reports not-found (without throwing or dropping the row) for an unknown id', async () => {
    const results = (await bulkUpsertProducts('s1', [{ id: 'ghost', name: 'X', price: 1 }]));
    expect(results).toEqual([{ id: 'ghost', action: 'not-found' }]);
  });

  it('de-duplicates slugs against existing products in the same store', async () => {
    const results = (await bulkUpsertProducts('s1', [{ name: 'Widget', price: 11, stock: 1 }]));
    const created = db.find((p) => p.id === results[0]!.id)!;
    expect(created.slug).toBe('widget-2');
  });

  it('returns exactly one result per input row, in order, even across a mix of create/update/not-found', async () => {
    const results = (await bulkUpsertProducts('s1', [
      { name: 'New one', price: 5 },
      { id: 'p1', name: 'Widget v2', price: 10 },
      { id: 'ghost', name: 'X', price: 1 },
    ]));
    expect(results.map((r) => r.action)).toEqual(['create', 'update', 'not-found']);
  });
});

describe('isSkuTaken', () => {
  it('is true for another product in the same store with the same sku', () => {
    expect(isSkuTaken('s1', 'W-1')).toBe(true);
  });

  it('is false when excluding the product that owns that sku (editing itself)', () => {
    expect(isSkuTaken('s1', 'W-1', 'p1')).toBe(false);
  });

  it('is false for a sku that only exists in a different store', () => {
    expect(isSkuTaken('s2', 'W-1')).toBe(false);
  });

  it('is false for an unused sku', () => {
    expect(isSkuTaken('s1', 'NEW-SKU')).toBe(false);
  });
});

describe('updateChangesProduct (no-op detection for the import preview)', () => {
  const base: StoreProduct = {
    id: 'p1', storeId: 's1', slug: 'widget', name: 'Widget', description: 'Nice', price: 10,
    stock: 5, categoryId: 'c1', tags: ['sale'], sku: 'W-1', createdAt: '2026-01-01T00:00:00.000Z',
  };
  const path = ['Tools']; // resolved chain of base.categoryId

  it('is false (no change) when every provided field equals the existing product', () => {
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, stock: 5, sku: 'W-1', tags: ['sale'], description: 'Nice', categoryPath: ['Tools'] }, path)).toBe(false);
  });

  it('is false when blank cells (undefined fields) leave everything but the matched value alone — a sku+stock feed with identical stock', () => {
    // resolveSkuMatches backfills name/price to the existing values; stock matches → pure no-op.
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, stock: 5 }, path)).toBe(false);
  });

  it('is true when stock actually differs', () => {
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, stock: 3 }, path)).toBe(true);
  });

  it('is true when price, name, description, sku, tags, or category differ', () => {
    expect(updateChangesProduct(base, { name: 'Widget', price: 12 }, path)).toBe(true);
    expect(updateChangesProduct(base, { name: 'Renamed', price: 10 }, path)).toBe(true);
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, description: 'Different' }, path)).toBe(true);
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, sku: 'W-2' }, path)).toBe(true);
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, tags: ['sale', 'new'] }, path)).toBe(true);
    expect(updateChangesProduct(base, { name: 'Widget', price: 10, categoryPath: ['Tools', 'Power'] }, path)).toBe(true);
  });

  it('ignores an undefined field (blank cell) even when the stored value is set', () => {
    // No sku/tags/description/category in the row → each is "leave unchanged", never a diff.
    expect(updateChangesProduct(base, { name: 'Widget', price: 10 }, path)).toBe(false);
  });

  it('detects a changed variant matrix (stock per combo) and ignores an identical one', () => {
    const variantProduct: StoreProduct = {
      ...base, variants: [{ name: 'Size', options: ['S', 'L'] }],
      variantStock: { S: 2, L: 3 }, stock: 5,
    };
    const same = { name: 'Widget', price: 10, stock: 5, variants: [{ name: 'Size', options: ['S', 'L'] }], variantStock: { S: 2, L: 3 } };
    const changed = { name: 'Widget', price: 10, stock: 6, variants: [{ name: 'Size', options: ['S', 'L'] }], variantStock: { S: 2, L: 4 } };
    expect(updateChangesProduct(variantProduct, same, path)).toBe(false);
    expect(updateChangesProduct(variantProduct, changed, path)).toBe(true);
  });
});
