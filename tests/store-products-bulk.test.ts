/**
 * The CSV batch upsert, against a real Postgres (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * The previous version of this file mocked `node:fs` and asserted against an in-memory array,
 * which is how the whole module could have been replaced by one that wrote nothing and stayed
 * green. Rewritten against the database, plus the two properties the move is supposed to buy: the
 * batch is ONE transaction (a file that fails halfway leaves no half-import), and a concurrently
 * running import can no longer erase this one's products — the failure the file version was a
 * single `await` away from, and the reason `resolveOrCreateCategoryPaths` had to be hoisted above
 * the catalog read while products still lived in JSON.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { comboKey } from '../src/lib/variant-combo.js';
import {
  createProduct, getProductById, getProductsByStoreId, type StoreProduct,
} from '../src/lib/store-products.js';
import { bulkUpsertProducts, updateChangesProduct } from '../src/lib/store-products-bulk.js';
import { getCategoriesByStoreId } from '../src/lib/store-categories.js';

let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `bulk-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

let storeId = '';
let otherStoreId = '';
let widget: StoreProduct;
let foreign: StoreProduct;

beforeEach(async () => {
  storeId = await freshStore();
  otherStoreId = await freshStore();
  widget = await createProduct(storeId, {
    name: 'Widget', price: 10, stock: 5, tags: ['sale'], sku: 'W-1', description: '',
  });
  foreign = await createProduct(otherStoreId, { name: 'Other store item', price: 20, stock: 2 });
});

describe('bulkUpsertProducts', () => {
  it('creates a new product with a fresh id/slug and default fields', async () => {
    const results = await bulkUpsertProducts(storeId, [{ name: 'Gadget', price: 30, stock: 7 }]);
    expect(results).toEqual([{ id: expect.any(String), action: 'create', product: expect.objectContaining({ name: 'Gadget' }) }]);
    expect(await getProductById(results[0]!.id)).toMatchObject({ storeId, name: 'Gadget', price: 30, stock: 7, slug: 'gadget' });
  });

  it('defaults a create row with no stock cell to 0', async () => {
    const results = await bulkUpsertProducts(storeId, [{ name: 'Gadget', price: 30 }]);
    expect((await getProductById(results[0]!.id))!.stock).toBe(0);
  });

  it('updates price/stock/name in place, preserving id/storeId/createdAt', async () => {
    const results = await bulkUpsertProducts(storeId, [{ id: widget.id, name: 'Widget Pro', price: 15, stock: 9 }]);
    expect(results.map((r) => r.action)).toEqual(['update']);
    expect(await getProductById(widget.id)).toMatchObject({
      id: widget.id, storeId, createdAt: widget.createdAt, name: 'Widget Pro', price: 15, stock: 9,
    });
  });

  it('preserves stock/tags/sku/description when the update row omits them (blank CSV cell), instead of wiping them', async () => {
    await bulkUpsertProducts(storeId, [{ id: widget.id, name: 'Widget Renamed', price: 12 }]);
    expect(await getProductById(widget.id)).toMatchObject({
      name: 'Widget Renamed', price: 12, stock: 5, tags: ['sale'], sku: 'W-1',
    });
  });

  it('overwrites sku when the row explicitly provides one, and sets it on a fresh create', async () => {
    await bulkUpsertProducts(storeId, [{ id: widget.id, name: 'Widget', price: 12, sku: 'W-1-NEW' }]);
    expect((await getProductById(widget.id))!.sku).toBe('W-1-NEW');

    const results = await bulkUpsertProducts(storeId, [{ name: 'Gadget', price: 5, sku: 'G-1' }]);
    expect((await getProductById(results[0]!.id))!.sku).toBe('G-1');
  });

  it('does not touch a product belonging to a different store even if a matching id is passed', async () => {
    const results = await bulkUpsertProducts(storeId, [{ id: foreign.id, name: 'Hijacked', price: 1, stock: 1 }]);
    expect(results).toEqual([{ id: foreign.id, action: 'not-found' }]);
    expect(await getProductById(foreign.id)).toMatchObject({ name: 'Other store item', price: 20, stock: 2 });
  });

  it('reports not-found (without throwing or dropping the row) for an unknown id', async () => {
    const ghost = crypto.randomUUID();
    expect(await bulkUpsertProducts(storeId, [{ id: ghost, name: 'X', price: 1 }])).toEqual([{ id: ghost, action: 'not-found' }]);
    // An id that is not even a uuid used to be an ordinary miss on a JSON array; Postgres would
    // reject the literal outright, so it has to stay a miss and not a 500.
    expect(await bulkUpsertProducts(storeId, [{ id: 'ghost', name: 'X', price: 1 }])).toEqual([{ id: 'ghost', action: 'not-found' }]);
  });

  it('de-duplicates slugs against existing products in the same store', async () => {
    const results = await bulkUpsertProducts(storeId, [{ name: 'Widget', price: 11, stock: 1 }]);
    expect((await getProductById(results[0]!.id))!.slug).toBe('widget-2');
  });

  it('de-duplicates slugs WITHIN one batch, not only against the stored catalog', async () => {
    const results = await bulkUpsertProducts(storeId, [
      { name: 'Gizmo', price: 1 },
      { name: 'Gizmo', price: 2 },
    ]);
    const slugs = await Promise.all(results.map(async (r) => (await getProductById(r.id))!.slug));
    expect(new Set(slugs).size).toBe(2);
  });

  it('returns exactly one result per input row, in order, even across a mix of create/update/not-found', async () => {
    const results = await bulkUpsertProducts(storeId, [
      { name: 'New one', price: 5 },
      { id: widget.id, name: 'Widget v2', price: 10 },
      { id: crypto.randomUUID(), name: 'X', price: 1 },
    ]);
    expect(results.map((r) => r.action)).toEqual(['create', 'update', 'not-found']);
  });

  it('creates the categories a row names and files the product under the leaf', async () => {
    const results = await bulkUpsertProducts(storeId, [
      { name: 'Drill', price: 99, categoryPath: ['כלים', 'חשמליים'] },
    ]);
    const categories = await getCategoriesByStoreId(storeId);
    const leaf = categories.find((c) => c.name === 'חשמליים')!;
    expect(leaf.parentId).toBe(categories.find((c) => c.name === 'כלים')!.id);
    expect((await getProductById(results[0]!.id))!.categoryId).toBe(leaf.id);
  });

  it('replaces a variant product\'s whole matrix from a variant row, and leaves it alone on a plain one', async () => {
    const S = comboKey({ מידה: 'S' });
    const M = comboKey({ מידה: 'M' });
    const created = await createProduct(storeId, {
      name: 'Shirt', price: 50, stock: 4,
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { [S]: 1, [M]: 3 },
    });

    await bulkUpsertProducts(storeId, [{
      id: created.id, name: 'Shirt', price: 50, stock: 12,
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { [S]: 5, [M]: 7 },
      variantSku: { [S]: 'SH-S' },
    }]);
    expect(await getProductById(created.id)).toMatchObject({ variantStock: { [S]: 5, [M]: 7 }, variantSku: { [S]: 'SH-S' } });

    // A plain row must not clobber the matrix — that is the "blank cell = leave unchanged" rule
    // applied to the one field a seller cannot express in a flat spreadsheet.
    await bulkUpsertProducts(storeId, [{ id: created.id, name: 'Shirt renamed', price: 55 }]);
    expect(await getProductById(created.id)).toMatchObject({ variantStock: { [S]: 5, [M]: 7 }, variantSku: { [S]: 'SH-S' } });
  });

  it('turns a salePrice into a ₪-off discount, and a zero into no discount at all', async () => {
    await bulkUpsertProducts(storeId, [{ id: widget.id, name: 'Widget', price: 10, salePrice: 7.5 }]);
    expect((await getProductById(widget.id))!.discount).toEqual({ type: 'amount', value: 2.5 });
    await bulkUpsertProducts(storeId, [{ id: widget.id, name: 'Widget', price: 10, salePrice: 0 }]);
    expect((await getProductById(widget.id))!.discount).toBeUndefined();
  });

  // The property the file version had by rewriting the file once, and the one a per-row
  // create/update loop would have thrown away. The second row here collides with the first row's
  // sku on the store's partial unique index, so the statement raises — and NOTHING may remain.
  it('writes the whole batch or none of it', async () => {
    const before = (await getProductsByStoreId(storeId)).length;
    await expect(bulkUpsertProducts(storeId, [
      { name: 'First', price: 1, sku: 'DUP' },
      { name: 'Second', price: 2, sku: 'DUP' },
    ])).rejects.toThrow();
    expect((await getProductsByStoreId(storeId)).length).toBe(before);
  });

  // Two imports landing at once — two dashboard tabs, or the feed sync beside a manual upload.
  // While the catalog was one JSON file rewritten whole, an `await` between the read and the write
  // was where one of them silently disappeared: both read the same snapshot, both reported
  // success, and the second write erased the first's products.
  it('does not lose a concurrently running import\'s products', async () => {
    await Promise.all([
      bulkUpsertProducts(storeId, [{ name: 'A', price: 1, stock: 1 }]),
      bulkUpsertProducts(storeId, [{ name: 'B', price: 2, stock: 2 }]),
    ]);
    expect((await getProductsByStoreId(storeId)).map((p) => p.name).sort()).toEqual(['A', 'B', 'Widget']);
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
