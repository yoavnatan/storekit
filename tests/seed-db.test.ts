/**
 * The database half of the two seeders (`scripts/lib/seed-db.mjs`).
 *
 * **This file exists because of how the seeders broke.** They kept writing `data/sellers.json`,
 * `data/stores.json`, `data/store-categories.json` and `data/store-products.json` after those four
 * moved to Postgres, so both scripts ran, printed a success line and created nothing — no error, no
 * red test, and it stayed that way for three modules. What was missing was never a test of the
 * DummyJSON fetching or the Hebrew copy; it was one assertion that after a seed, the APPLICATION
 * can see a store with products in it. That is what this asserts, through the app's own readers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { purge, writeCatalog } from '../scripts/lib/seed-db.mjs';
import { getDatabase, query } from '../src/lib/db.js';
import { getStoreBySlug, getVisibleStores } from '../src/lib/stores.js';
import { getVisibleProductsByStoreId } from '../src/lib/store-products.js';
import { getCategoriesByStoreId } from '../src/lib/store-categories.js';
import { comboKey } from '../src/lib/variant-combo.js';

/** What the seeders hand `writeCatalog`: a single client, so its BEGIN/COMMIT bracket the run. */
const db = { query: (text: string, params?: unknown[]) => getDatabase().query(text, params) };

const DEMO_SUFFIX = '@demo.local';
const DEMO_SELLERS = `email LIKE '%' || $1`;
const DEMO_STORES = `seller_id IN (SELECT id FROM sellers WHERE ${DEMO_SELLERS})`;

/** One store's worth of seed records, in the shapes both seeders build. */
function catalog(over: { slug?: string; email?: string; demo?: boolean } = {}) {
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const categoryId = crypto.randomUUID();
  const slug = over.slug ?? `seeded-${crypto.randomBytes(3).toString('hex')}`;
  return {
    sellers: [{ id: sellerId, name: 'נועה כהן', email: over.email ?? `${slug}${DEMO_SUFFIX}`, passwordHash: 'salt:hash', createdAt: '2026-01-01T00:00:00.000Z' }],
    stores: [{
      id: storeId, sellerId, slug, name: 'סטודיו לבוש', tagline: 't', description: 'd',
      colors: { primary: '#111827', accent: '#f97316' }, categories: ['אופנה'],
      shipping: { selfPickup: true }, profileImage: 'https://cdn.test/p.webp',
      address: 'דיזנגוף 112, תל אביב', addressVisible: true,
      hours: { sun: { closed: false, open: '09:00', close: '19:00' } }, hoursVisible: true,
      demo: over.demo ?? false, createdAt: '2026-01-02T00:00:00.000Z',
    }],
    categories: [{ id: categoryId, storeId, name: 'נשים', parentId: null, order: 0, createdAt: '2026-01-02T00:00:00.000Z' }],
    products: [{
      id: crypto.randomUUID(), storeId, slug: 'shirt-1', name: 'חולצה', description: 'd',
      price: 79.9, stock: 12, images: ['https://cdn.test/1.webp', 'https://cdn.test/2.webp'],
      categoryId, tags: ['חדש'],
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { [comboKey({ מידה: 'S' })]: 5, [comboKey({ מידה: 'M' })]: 7 },
      createdAt: '2026-01-03T00:00:00.000Z',
    }],
    ids: { sellerId, storeId, categoryId, slug },
  };
}

beforeEach(async () => {
  await purge(db, { storeWhere: DEMO_STORES, sellerWhere: DEMO_SELLERS, params: [DEMO_SUFFIX] });
});

describe('writeCatalog', () => {
  // The assertion whose absence let both seeders report success over an empty catalog.
  it('produces a store the application can actually see, with products on its shelves', async () => {
    const set = catalog();
    await writeCatalog(db, set);

    const store = await getStoreBySlug(set.ids.slug);
    expect(store).not.toBeNull();
    expect(store!.name).toBe('סטודיו לבוש');
    expect(store!.shipping).toEqual({ selfPickup: true });
    expect(store!.addressVisible).toBe(true);

    const products = await getVisibleProductsByStoreId(store!.id);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ name: 'חולצה', price: 79.9, stock: 12 });
    expect(products[0]!.images).toEqual(['https://cdn.test/1.webp', 'https://cdn.test/2.webp']);
    expect(products[0]!.variantStock).toEqual({ [comboKey({ מידה: 'S' })]: 5, [comboKey({ מידה: 'M' })]: 7 });
    expect(products[0]!.categoryId).toBe(set.ids.categoryId);

    const categories = await getCategoriesByStoreId(store!.id);
    expect(categories.map((c) => c.name)).toEqual(['נשים']);
  });

  it('marks a showcase store demo, which is what keeps it out of shopper discovery', async () => {
    const set = catalog({ demo: true });
    await writeCatalog(db, set);
    expect((await getStoreBySlug(set.ids.slug))!.demo).toBe(true);
  });

  // The purge and the write are one transaction on purpose: both seeders do their network work
  // first, and a purge that committed on its own would let a failed run delete the previous
  // showcase stores and put nothing back.
  it('leaves the previous set untouched when the write fails', async () => {
    const first = catalog();
    await writeCatalog(db, first);

    const broken = catalog();
    // Two products claiming one id — the insert raises, after the purge statement has run.
    broken.products = [broken.products[0]!, { ...broken.products[0]! }];
    await expect(writeCatalog(db, {
      purge: { storeWhere: DEMO_STORES, sellerWhere: DEMO_SELLERS, params: [DEMO_SUFFIX] },
      ...broken,
    })).rejects.toThrow();

    expect(await getStoreBySlug(first.ids.slug)).not.toBeNull();
    expect(await getVisibleProductsByStoreId(first.ids.storeId)).toHaveLength(1);
  });

  it('replaces the previous set in one step when the write succeeds', async () => {
    const first = catalog();
    await writeCatalog(db, first);
    const second = catalog();
    await writeCatalog(db, {
      purge: { storeWhere: DEMO_STORES, sellerWhere: DEMO_SELLERS, params: [DEMO_SUFFIX] },
      ...second,
    });
    expect(await getStoreBySlug(first.ids.slug)).toBeNull();
    expect(await getStoreBySlug(second.ids.slug)).not.toBeNull();
  });
});

describe('purge', () => {
  it('removes the seeded set and everything hanging off it, and leaves real data alone', async () => {
    const seeded = catalog();
    await writeCatalog(db, seeded);
    const realStores = (await getVisibleStores()).length;

    const removed = await purge(db, { storeWhere: DEMO_STORES, sellerWhere: DEMO_SELLERS, params: [DEMO_SUFFIX] });
    expect(removed).toEqual({ stores: 1, sellers: 1 });
    expect(await getStoreBySlug(seeded.ids.slug)).toBeNull();

    // The store's categories, products, images and per-combo stock go with it — `stores` is
    // ON DELETE CASCADE all the way down, which is what makes a re-seed idempotent.
    for (const [table, column] of [['store_categories', 'store_id'], ['store_products', 'store_id']] as const) {
      const { rows } = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`, [seeded.ids.storeId]);
      expect(rows[0]!.n).toBe(0);
    }
    // The repo's own fixture stores are not seeded data and must survive.
    expect((await getVisibleStores()).length).toBe(realStores - 1);
  });
});
