/* eslint-disable sonarjs/no-floating-point-equality -- exactness is the property under test.
 * The column is integer agorot, so `toBe(1.01)` asserts the round-trip landed on the agora;
 * a tolerance would pass on exactly the drift these assertions exist to catch (§7.7). Same
 * reasoning, and the same disable, as tests/discounts.test.ts. */
/**
 * The catalog, against a real Postgres — the fourth module moved off `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2).
 *
 * **Written from scratch, for the fourth time, for the same reason, and it was the worst case
 * yet.** §9.1 ("the existing tests pass unchanged") only proves something when a test could have
 * failed. The suite's coverage of this module was: `slugify` (pure), `getEffectiveStock` (pure),
 * and a `decrementStock` group running against a mocked `node:fs`. Everything else that touches a
 * product — `product-listing`, `checkout`, `product-feed`, `sale-scope`, `product-stock-cas`,
 * `seller-products-query` — either builds product objects by hand or mocks this module wholesale.
 * A replacement that returned an empty catalog for every store, or one that dropped every image
 * and every per-combo stock number, would have left 123 test files green.
 *
 * So this pins the behaviour the file-backed version had, plus what the move was meant to gain:
 * a slug that is unique per STORE and not globally (§7.1), flags that survive as `false` rather
 * than `NULL` (§7.12), prices that round-trip through integer agorot (§7.7), and a stock decrement
 * whose verdict is the affected-row count of one statement instead of a process-local mutex (§7.5).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { comboKey } from '../src/lib/variant-combo.js';
import {
  countStockAlerts,
  createProduct,
  decrementStock,
  deleteProduct,
  getAllProducts,
  getEffectiveStock,
  getProductById,
  getProductBySlug,
  getProductsByStoreId,
  getVisibleProductsByStoreId,
  getVisibleProductsByStoreIds,
  isSkuTaken,
  restockProduct,
  updateProduct,
} from '../src/lib/store-products.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const TACHSHITIM = '22222222-2222-4222-8222-000000000002';
const AGARTAL = '44444444-4444-4444-8444-000000000001';   // variants + images + discount
const OTHER_AGARTAL = '44444444-4444-4444-8444-000000000002'; // SAME slug, other store (§7.1)
const MENORA = '44444444-4444-4444-8444-000000000003';    // hidden: true
const HOUSEWARES = '33333333-3333-4333-8333-000000000001';

const RED = comboKey({ צבע: 'אדום' });   // has a variantStock override (3)
const BLUE = comboKey({ צבע: 'כחול' });  // has a variantSku but NO stock override

/** A store of this test's own, so slug and stock tests cannot disturb each other. */
let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `prod-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

describe('reading the catalog', () => {
  it('returns a store\'s own products and nothing else', async () => {
    const products = await getProductsByStoreId(KERAMIKA);
    expect(products.map((p) => p.id).sort()).toEqual([AGARTAL, MENORA].sort());
  });

  it('orders newest-first with a stable tie-break, so a grid does not reshuffle between loads (§7.13)', async () => {
    const first = (await getProductsByStoreId(KERAMIKA)).map((p) => p.id);
    const second = (await getProductsByStoreId(KERAMIKA)).map((p) => p.id);
    expect(first).toEqual([MENORA, AGARTAL]); // 2026-01-09 before 2026-01-07
    expect(second).toEqual(first);
  });

  it('rebuilds every nested field the import wrote — images in order, specs, variants, per-combo stock and sku, per-colour photos', async () => {
    const product = (await getProductById(AGARTAL))!;
    expect(product.images).toEqual(['https://cdn.test/a.webp', 'https://cdn.test/b.webp']);
    expect(product.specs).toEqual([{ label: 'גובה', value: '20 ס"מ' }]);
    expect(product.variants).toEqual([{ name: 'צבע', options: ['אדום', 'כחול'] }]);
    expect(product.variantStock).toEqual({ [RED]: 3 });
    expect(product.variantSku).toEqual({ [BLUE]: 'AG-1-BLUE' });
    expect(product.variantImages).toEqual({ אדום: 'https://cdn.test/red.webp' });
    expect(product.tags).toEqual(['מתנה']);
    expect(product.sku).toBe('AG-1');
    expect(product.categoryId).toBe(HOUSEWARES);
  });

  // §7.14: row counts and money totals both pass while every nested field imports empty. A
  // product with no variant matrix looks entirely healthy and simply cannot be bought per combo.
  it('does not silently flatten a variant product into a plain one', async () => {
    const rows = await getAllProducts();
    expect(rows.filter((p) => p.variants?.length).length).toBeGreaterThan(0);
    expect(rows.filter((p) => p.variantStock && Object.keys(p.variantStock).length).length).toBeGreaterThan(0);
  });

  // §7.7: the column is integer agorot, the app still speaks ILS. 1.005 is the value that decides
  // whether the write rounds by money.ts's rule — it is 1.00499999… in binary and rounds DOWN
  // without the EPSILON nudge, which is how a catalog silently loses an agora per product.
  it('round-trips a price through integer agorot by money.ts\'s rounding rule', async () => {
    expect((await getProductById(AGARTAL))!.price).toBe(1.01);
    expect((await getProductById(OTHER_AGARTAL))!.price).toBe(250.5);
  });

  it('keeps a ₪-off discount and a percent discount in the shape the form writes', async () => {
    expect((await getProductById(AGARTAL))!.discount).toEqual({ type: 'percent', value: 10, showBadge: false });
    // 12.345 → 1235 agorot → 12.35, the same rounding the JSON era applied on save.
    expect((await getProductById(OTHER_AGARTAL))!.discount).toEqual({ type: 'amount', value: 12.35 });
  });

  // §7.1, measured: 47 product slugs repeat ACROSS stores in the real data and none repeats
  // inside one. A global UNIQUE(slug) fails on the first import row; a lookup that forgot the
  // store would serve the wrong shop's product at the right URL.
  it('resolves the same slug to a different product in each store', async () => {
    expect((await getProductBySlug(KERAMIKA, 'agartal'))!.id).toBe(AGARTAL);
    expect((await getProductBySlug(TACHSHITIM, 'agartal'))!.id).toBe(OTHER_AGARTAL);
  });

  it('does not serve the page at another capitalisation, so one product keeps one URL', async () => {
    expect(await getProductBySlug(KERAMIKA, 'Agartal')).toBeNull();
  });

  // Postgres REJECTS a malformed uuid literal rather than failing to match it, so without the
  // shape check a stale dashboard link or an old cookie turns "no such product" into a 500.
  it('answers "not found" — not an error — for an id that is not a uuid', async () => {
    expect(await getProductById('product-1')).toBeNull();
    expect(await getProductBySlug('store-1', 'agartal')).toBeNull();
    expect(await getProductsByStoreId('store-1')).toEqual([]);
  });

  it('spans every store in getAllProducts', async () => {
    const ids = (await getAllProducts()).map((p) => p.id);
    expect(ids).toContain(AGARTAL);
    expect(ids).toContain(OTHER_AGARTAL);
  });
});

// §7.12 — the likeliest silent failure of this whole migration. Most products in the real data
// carry neither `hidden` nor `blocked`; in JS a missing flag is falsy so the product is visible,
// but `WHERE hidden = false` does NOT match a NULL row and the product vanishes from the
// storefront with no error and no failing test.
describe('visibility', () => {
  it('keeps a product whose JSON carried no hidden/blocked key on the shelf', async () => {
    const visible = await getVisibleProductsByStoreId(KERAMIKA);
    expect(visible.map((p) => p.id)).toEqual([AGARTAL]);
    const agartal = (await getProductById(AGARTAL))!;
    expect(agartal.hidden).toBeUndefined();
    expect(agartal.blocked).toBeUndefined();
  });

  it('drops a seller-hidden product, and puts it back when the seller reverses it', async () => {
    expect((await getVisibleProductsByStoreId(KERAMIKA)).map((p) => p.id)).not.toContain(MENORA);
    await updateProduct(MENORA, { hidden: false });
    expect((await getVisibleProductsByStoreId(KERAMIKA)).map((p) => p.id)).toContain(MENORA);
    await updateProduct(MENORA, { hidden: true });
  });

  it('drops an admin-blocked product too', async () => {
    await updateProduct(AGARTAL, { blocked: true });
    expect(await getVisibleProductsByStoreId(KERAMIKA)).toEqual([]);
    await updateProduct(AGARTAL, { blocked: false });
  });

  it('counts a stock alert only for products actually on sale', async () => {
    const storeId = await freshStore();
    await createProduct(storeId, { name: 'Low', price: 5, stock: 1 });
    await createProduct(storeId, { name: 'Plenty', price: 5, stock: 50 });
    const hidden = await createProduct(storeId, { name: 'Retired', price: 5, stock: 0 });
    expect(await countStockAlerts(storeId, 3)).toBe(2);
    // An intentional take-down must never nag — that is the whole point of `hidden`.
    await updateProduct(hidden.id, { hidden: true });
    expect(await countStockAlerts(storeId, 3)).toBe(1);
  });
});

describe('creating', () => {
  it('keeps a Hebrew name as the slug rather than collapsing it to a counter', async () => {
    const storeId = await freshStore();
    const product = await createProduct(storeId, { name: 'חולצה כחולה', price: 40 });
    expect(product.slug).toBe('חולצה-כחולה');
  });

  it('bumps a slug already taken IN THIS STORE, and leaves the base free for another store', async () => {
    const a = await freshStore();
    const b = await freshStore();
    expect((await createProduct(a, { name: 'Widget', price: 1 })).slug).toBe('widget');
    expect((await createProduct(a, { name: 'Widget', price: 1 })).slug).toBe('widget-2');
    // The §7.1 case a global unique index would have broken.
    expect((await createProduct(b, { name: 'Widget', price: 1 })).slug).toBe('widget');
  });

  // The bump used to come from a read that ran before the write, which is exactly the check two
  // simultaneous saves both pass. Here the index is the arbiter, so the loop simply tries again.
  it('gives two products created at the same instant two different slugs', async () => {
    const storeId = await freshStore();
    const created = await Promise.all([
      createProduct(storeId, { name: 'Same Name', price: 1 }),
      createProduct(storeId, { name: 'Same Name', price: 1 }),
      createProduct(storeId, { name: 'Same Name', price: 1 }),
    ]);
    expect(new Set(created.map((p) => p.slug)).size).toBe(3);
  });

  it('writes every optional field, and omits the ones it was not given', async () => {
    const storeId = await freshStore();
    const created = await createProduct(storeId, {
      name: 'Full', price: 12.34, stock: 4,
      images: ['https://cdn.test/1.webp', 'https://cdn.test/2.webp'],
      categoryId: HOUSEWARES,
      tags: ['a', 'b'], sku: 'F-1',
      specs: [{ label: 'l', value: 'v' }],
      discount: { type: 'amount', value: 2.5, startsAt: '2026-03-01', endsAt: '2026-03-31' },
      sellerNote: 'private',
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { [comboKey({ מידה: 'S' })]: 2 },
      variantSku: { [comboKey({ מידה: 'M' })]: 'F-1-M' },
      variantImages: { S: 'https://cdn.test/s.webp' },
    });
    const stored = (await getProductById(created.id))!;
    expect(stored.price).toBe(12.34);
    expect(stored.images).toEqual(['https://cdn.test/1.webp', 'https://cdn.test/2.webp']);
    expect(stored.sellerNote).toBe('private');
    expect(stored.variantStock).toEqual({ [comboKey({ מידה: 'S' })]: 2 });
    expect(stored.variantSku).toEqual({ [comboKey({ מידה: 'M' })]: 'F-1-M' });
    expect(stored.variantImages).toEqual({ S: 'https://cdn.test/s.webp' });
    // A `date` read back as text, not as a Date parsed at local midnight (§7.8).
    expect(stored.discount).toEqual({ type: 'amount', value: 2.5, startsAt: '2026-03-01', endsAt: '2026-03-31' });

    const plain = await createProduct(storeId, { name: 'Plain', price: 1 });
    expect(plain.images).toBeUndefined();
    expect(plain.tags).toBeUndefined();
    expect(plain.discount).toBeUndefined();
    expect(plain.stock).toBe(0);
  });

  it('drops a categoryId that is not a real id instead of raising', async () => {
    const storeId = await freshStore();
    const created = await createProduct(storeId, { name: 'X', price: 1, categoryId: 'cat-1' });
    expect(created.categoryId).toBeUndefined();
  });
});

describe('updating', () => {
  it('changes only the fields it was given', async () => {
    const storeId = await freshStore();
    const created = await createProduct(storeId, { name: 'A', price: 10, stock: 5, sku: 'S-1', tags: ['t'] });
    const updated = (await updateProduct(created.id, { price: 11 }))!;
    expect(updated).toMatchObject({ id: created.id, name: 'A', price: 11, stock: 5, sku: 'S-1', tags: ['t'] });
    expect(updated.createdAt).toBe(created.createdAt);
  });

  // The `updateStore` lesson, and it applies with more force here: EVERY save path in
  // api/product.ts writes `sku: sku || undefined` / `discount` / `variantStock: … : undefined`
  // meaning "clear it". Building the SET from the values instead of the keys would turn every
  // removal into a silent no-op — a cancelled sale would reappear on the next page load.
  it('treats a key whose value is undefined as "clear this field", not as "leave it alone"', async () => {
    const storeId = await freshStore();
    const created = await createProduct(storeId, {
      name: 'A', price: 10, sku: 'S-1', sellerNote: 'n',
      discount: { type: 'percent', value: 20 },
    });
    const cleared = (await updateProduct(created.id, { sku: undefined, discount: undefined, sellerNote: undefined }))!;
    expect(cleared.sku).toBeUndefined();
    expect(cleared.discount).toBeUndefined();
    expect(cleared.sellerNote).toBeUndefined();
    expect((await getProductById(created.id))!.discount).toBeUndefined();
  });

  it('replaces the image list in the order it was given, and clears it when given none', async () => {
    const storeId = await freshStore();
    const created = await createProduct(storeId, { name: 'A', price: 1, images: ['https://cdn.test/1.webp'] });
    const swapped = (await updateProduct(created.id, { images: ['https://cdn.test/b.webp', 'https://cdn.test/a.webp'] }))!;
    expect(swapped.images).toEqual(['https://cdn.test/b.webp', 'https://cdn.test/a.webp']);
    expect((await updateProduct(created.id, { images: [] }))!.images).toBeUndefined();
  });

  // `variantStock` and `variantSku` are two partial maps sharing ONE table. The single-product
  // editor writes the stock map and never the codes (record-rev.ts keeps `variantSku` out of the
  // form on purpose), so a write that rebuilt the table from the stock map alone would delete
  // every per-combo code a CSV import had set — silently, on an ordinary save.
  it('does not lose per-combo SKUs when only the stock map is written, or vice versa', async () => {
    const storeId = await freshStore();
    const S = comboKey({ מידה: 'S' });
    const M = comboKey({ מידה: 'M' });
    const created = await createProduct(storeId, {
      name: 'V', price: 10, stock: 5,
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { [S]: 2, [M]: 3 },
      variantSku: { [S]: 'V-S', [M]: 'V-M' },
    });
    const afterStock = (await updateProduct(created.id, { variantStock: { [S]: 9, [M]: 1 } }))!;
    expect(afterStock.variantStock).toEqual({ [S]: 9, [M]: 1 });
    expect(afterStock.variantSku).toEqual({ [S]: 'V-S', [M]: 'V-M' });

    const afterSku = (await updateProduct(created.id, { variantSku: { [S]: 'V-S2' } }))!;
    expect(afterSku.variantStock).toEqual({ [S]: 9, [M]: 1 });
    expect(afterSku.variantSku).toEqual({ [S]: 'V-S2' });
  });

  it('returns null for an unknown or malformed id instead of raising', async () => {
    expect(await updateProduct(crypto.randomUUID(), { name: 'x' })).toBeNull();
    expect(await updateProduct('product-1', { name: 'x' })).toBeNull();
  });
});

describe('deleting', () => {
  it('removes the product and every row hanging off it', async () => {
    const storeId = await freshStore();
    const created = await createProduct(storeId, {
      name: 'D', price: 1, images: ['https://cdn.test/1.webp'],
      variants: [{ name: 'מידה', options: ['S'] }],
      variantStock: { [comboKey({ מידה: 'S' })]: 1 },
      variantImages: { S: 'https://cdn.test/s.webp' },
    });
    expect(await deleteProduct(created.id)).toBe(true);
    expect(await getProductById(created.id)).toBeNull();
    for (const table of ['product_images', 'product_variant_stock', 'product_variant_images']) {
      const { rows } = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE product_id = $1`, [created.id]);
      expect(rows[0]!.n).toBe(0);
    }
  });

  it('reports false for an id that was not there', async () => {
    expect(await deleteProduct(crypto.randomUUID())).toBe(false);
    expect(await deleteProduct('product-1')).toBe(false);
  });
});

describe('sku uniqueness', () => {
  it('is scoped to the store, and lets a product keep its own code while editing itself', async () => {
    const a = await freshStore();
    const b = await freshStore();
    const mine = await createProduct(a, { name: 'A', price: 1, sku: 'X-1' });
    await createProduct(b, { name: 'B', price: 1, sku: 'X-1' });

    expect(await isSkuTaken(a, 'X-1')).toBe(true);
    expect(await isSkuTaken(a, 'X-1', mine.id)).toBe(false);
    expect(await isSkuTaken(a, 'X-2')).toBe(false);
    expect(await isSkuTaken(b, 'X-1', mine.id)).toBe(true);
  });

  it('answers false for a malformed store id rather than raising', async () => {
    expect(await isSkuTaken('store-1', 'X-1')).toBe(false);
  });
});

/**
 * §7.5 — the section this whole module was waiting for.
 *
 * The old `decrementStock` read the count, decided, and wrote, serialised by a `Mutex` that only
 * ever existed inside ONE Node process: two instances meant two mutexes, two reads of the same
 * number and one unit sold twice, with nothing to report it. Here the precondition is part of the
 * write, so the affected-row count IS the verdict.
 */
describe('stock', () => {
  it('decrements the shared pool and reports the numbers on either side of the write', async () => {
    const storeId = await freshStore();
    const p = await createProduct(storeId, { name: 'P', price: 1, stock: 5 });
    expect(await decrementStock(p.id, 2)).toEqual({ ok: true, before: 5, after: 3 });
    expect((await getProductById(p.id))!.stock).toBe(3);
  });

  it('refuses — without writing — a purchase larger than the shelf', async () => {
    const storeId = await freshStore();
    const p = await createProduct(storeId, { name: 'P', price: 1, stock: 2 });
    expect(await decrementStock(p.id, 3)).toEqual({ ok: false, before: 2, after: 2 });
    expect((await getProductById(p.id))!.stock).toBe(2);
  });

  it('sells exactly the number of units on the shelf when every request arrives at once', async () => {
    const storeId = await freshStore();
    const p = await createProduct(storeId, { name: 'P', price: 1, stock: 3 });
    const results = await Promise.all(Array.from({ length: 6 }, () => decrementStock(p.id, 1)));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect((await getProductById(p.id))!.stock).toBe(0);
  });

  it('takes a variant with its own override out of that bucket alone', async () => {
    const before = (await getProductById(AGARTAL))!;
    expect(before.variantStock![RED]).toBe(3);
    expect(await decrementStock(AGARTAL, 1, { צבע: 'אדום' })).toEqual({ ok: true, before: 3, after: 2 });
    const after = (await getProductById(AGARTAL))!;
    expect(after.variantStock![RED]).toBe(2);
    expect(after.stock).toBe(before.stock); // the shared pool is untouched
    await restockProduct(AGARTAL, 1, { צבע: 'אדום' });
  });

  // Migration 0003. `variantStock` is a PARTIAL map — a combo with no entry sells from the shared
  // pool — and the blue vase carries a per-combo SKU but no stock override. Storing that row's
  // stock as 0 (which is what one shared NOT NULL column forces) would have read as "sold out"
  // and taken the combo off the shelf the moment the catalog moved, with no error anywhere.
  it('sells a combo that only carries a SKU out of the shared pool, not out of a phantom zero', async () => {
    const before = (await getProductById(AGARTAL))!;
    expect(before.variantSku![BLUE]).toBe('AG-1-BLUE');
    expect(before.variantStock![BLUE]).toBeUndefined();
    expect(getEffectiveStock(before, { צבע: 'כחול' })).toBe(before.stock);

    expect(await decrementStock(AGARTAL, 1, { צבע: 'כחול' })).toEqual({ ok: true, before: before.stock, after: before.stock - 1 });
    const after = (await getProductById(AGARTAL))!;
    expect(after.stock).toBe(before.stock - 1);
    expect(after.variantStock).toEqual({ [RED]: 3 });   // no override was invented
    expect(after.variantSku).toEqual({ [BLUE]: 'AG-1-BLUE' }); // and the code survived the write
    await restockProduct(AGARTAL, 1, { צבע: 'כחול' });
  });

  it('refuses a combo purchase larger than that combo\'s own bucket, even when the shared pool is deep', async () => {
    const storeId = await freshStore();
    const S = comboKey({ מידה: 'S' });
    const p = await createProduct(storeId, {
      name: 'V', price: 1, stock: 100,
      variants: [{ name: 'מידה', options: ['S'] }],
      variantStock: { [S]: 1 },
    });
    expect(await decrementStock(p.id, 2, { מידה: 'S' })).toEqual({ ok: false, before: 1, after: 1 });
    expect((await getProductById(p.id))!.variantStock).toEqual({ [S]: 1 });
  });

  it('restocks the same bucket a decrement came out of', async () => {
    const storeId = await freshStore();
    const S = comboKey({ מידה: 'S' });
    const p = await createProduct(storeId, {
      name: 'V', price: 1, stock: 4,
      variants: [{ name: 'מידה', options: ['S'] }],
      variantStock: { [S]: 4 },
    });
    await decrementStock(p.id, 3, { מידה: 'S' });
    expect(await restockProduct(p.id, 3, { מידה: 'S' })).toEqual({ ok: true, before: 1, after: 4 });
    expect((await getProductById(p.id))!.variantStock).toEqual({ [S]: 4 });
  });

  it('reports a miss for a product that is not there, instead of raising', async () => {
    expect(await decrementStock(crypto.randomUUID(), 1)).toEqual({ ok: false, before: 0, after: 0 });
    expect(await decrementStock('product-1', 1)).toEqual({ ok: false, before: 0, after: 0 });
  });
});

describe('getVisibleProductsByStoreIds', () => {
  // The homepage, /stores and the sitemap each hold a list of stores. Per-store that is N queries
  // fired at once, against a pool of ten with a five-second checkout timeout (§7.16).
  it('returns each store\'s own visible shelf, in the same order a single-store read would', async () => {
    const byStore = await getVisibleProductsByStoreIds([KERAMIKA, TACHSHITIM]);
    expect(byStore.get(KERAMIKA)!.map((p) => p.id)).toEqual((await getVisibleProductsByStoreId(KERAMIKA)).map((p) => p.id));
    expect(byStore.get(TACHSHITIM)!.map((p) => p.id)).toEqual([OTHER_AGARTAL]);
  });

  it('gives an empty shelf — never a missing key — for a store with nothing on it', async () => {
    const empty = await freshStore();
    const byStore = await getVisibleProductsByStoreIds([empty, KERAMIKA]);
    expect(byStore.get(empty)).toEqual([]);
  });

  it('ignores ids that are not uuids, and answers an empty map for no ids at all', async () => {
    expect(await getVisibleProductsByStoreIds(['store-1'])).toEqual(new Map());
    expect(await getVisibleProductsByStoreIds([])).toEqual(new Map());
  });
});

// The columns carry the discount bands as CHECK constraints, which a JSON file did not. A value
// outside them used to be stored as an inert record; here it would be a 500 on a form that worked
// the day before, so the module gives the same answer normalizeProductDiscount gives — no discount.
describe('a discount outside its allowed band', () => {
  it('stores no discount instead of raising', async () => {
    const storeId = await freshStore();
    const tooBig = await createProduct(storeId, { name: 'A', price: 100, discount: { type: 'percent', value: 200 } });
    expect(tooBig.discount).toBeUndefined();
    const zero = await createProduct(storeId, { name: 'B', price: 100, discount: { type: 'amount', value: 0 } });
    expect(zero.discount).toBeUndefined();

    const live = await createProduct(storeId, { name: 'C', price: 100, discount: { type: 'percent', value: 20 } });
    expect((await updateProduct(live.id, { discount: { type: 'percent', value: 0 } }))!.discount).toBeUndefined();
  });
});
