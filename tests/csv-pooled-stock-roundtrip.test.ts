/**
 * A variant product whose combos have NO per-combo stock must survive export → import unchanged.
 *
 * `variantStock` is a partial map: a combo with no entry sells from the product's shared pool
 * (store-products.ts#resolveStockField). The CSV had no way to say that. Export wrote
 * `variantStock[key] ?? p.stock` — the pool's number into every pooled combo's own cell — and
 * import read `inp.stock ?? 0` back as a bucket for each one. So a product with 10 units across 4
 * pooled combos exported four 10s and re-imported as 40, with every combo converted to a fixed
 * bucket it never had. The blank cell is now the wire form of "no bucket", on both sides.
 *
 * This is a round-trip test on purpose: each side is defensible alone and only the pair is wrong,
 * which is exactly the shape of bug that survives per-function tests.
 */
import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../src/lib/notifications.js', () => ({
  createNotification: () => {},
  deleteNotificationsByRelatedIds: () => {},
}));

const { query } = await import('../src/lib/db.js');
const { comboKey } = await import('../src/lib/variant-combo.js');
const { createProduct, getProductById } = await import('../src/lib/store-products.js');
const { productsToCsv } = await import('../src/lib/store-products-bulk.js');
const { runProductImport } = await import('../src/lib/store-products-import.js');

let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `csv-pool-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

const DIMS = [{ name: 'צבע', options: ['אדום', 'כחול'] }, { name: 'מידה', options: ['S', 'L'] }];
const RED_S = comboKey({ צבע: 'אדום', מידה: 'S' });

/** 10 units, four combos, NOT ONE of them counted separately — all on the shared pool. */
async function seedPooled(storeId: string) {
  return createProduct(storeId, { name: 'Chair', price: 100, stock: 10, description: '', variants: DIMS });
}

const importCsv = (storeId: string, csv: string) =>
  runProductImport({ storeId, sellerId: 'seller', csv, commit: true });

describe('CSV round-trip — a pooled combo stays pooled', () => {
  it('exports a blank stock cell for a combo with no bucket, never the pool number', async () => {
    const storeId = await freshStore();
    const product = await seedPooled(storeId);
    const csv = productsToCsv([product], [], 'he');

    const dataLines = csv.trim().split('\r\n').slice(1);
    expect(dataLines).toHaveLength(4); // one row per combo
    // Four rows each claiming 10 is what turned 10 units into 40 on re-import.
    expect(dataLines.some((l) => l.includes(',10,'))).toBe(false);
  });

  it('re-importing an untouched export changes nothing — not the pool, not the buckets', async () => {
    const storeId = await freshStore();
    const product = await seedPooled(storeId);

    await importCsv(storeId, productsToCsv([product], [], 'he'));

    const after = (await getProductById(product.id))!;
    expect(after.stock).toBe(10);                 // was 40 before the fix
    expect(after.variantStock ?? {}).toEqual({}); // every combo still on the pool
    expect(after.variants).toHaveLength(2);
  });

  it('is idempotent across a second round-trip, so repeated syncs cannot drift', async () => {
    const storeId = await freshStore();
    const product = await seedPooled(storeId);

    await importCsv(storeId, productsToCsv([product], [], 'he'));
    const once = (await getProductById(product.id))!;
    await importCsv(storeId, productsToCsv([once], [], 'he'));
    const twice = (await getProductById(product.id))!;

    expect(twice.stock).toBe(10);
    expect(twice.variantStock ?? {}).toEqual({});
  });

  it('still carries a combo that DOES have its own bucket, and leaves its siblings pooled', async () => {
    const storeId = await freshStore();
    const product = await createProduct(storeId, {
      name: 'Chair', price: 100, stock: 7, description: '',
      variants: DIMS, variantStock: { [RED_S]: 3 },
    });

    await importCsv(storeId, productsToCsv([product], [], 'he'));

    const after = (await getProductById(product.id))!;
    expect(after.variantStock).toEqual({ [RED_S]: 3 });
    // The pool is untouched: the file said nothing about it, so nothing overwrote it.
    expect(after.stock).toBe(7);
  });
});
