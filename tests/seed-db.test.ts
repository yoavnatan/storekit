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
import { DEMO_EMAIL_SUFFIX, purge, purgeOrdersOfStores, purgeOrphanJournalRows, writeCatalog } from '../scripts/lib/seed-db.mjs';
import { getDatabase, query } from '../src/lib/db.js';
import { getStoreBySlug, getVisibleStores } from '../src/lib/stores.js';
import { getVisibleProductsByStoreId } from '../src/lib/store-products.js';
import { getCategoriesByStoreId } from '../src/lib/store-categories.js';
import { getViewStatsForStore } from '../src/lib/store-pageviews.js';
import { countFavoriteStores, getWishlistCountsForStore } from '../src/lib/user-carts.js';
import { comboKey } from '../src/lib/variant-combo.js';

/** What the seeders hand `writeCatalog`: a single client, so its BEGIN/COMMIT bracket the run. */
const db = { query: (text: string, params?: unknown[]) => getDatabase().query(text, params) };


/** One store's worth of seed records, in the shapes both seeders build. */
function catalog(over: { slug?: string; email?: string; demo?: boolean } = {}) {
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  const categoryId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const slug = over.slug ?? `seeded-${crypto.randomBytes(3).toString('hex')}`;
  return {
    sellers: [{ id: sellerId, name: 'נועה כהן', email: over.email ?? `${slug}${DEMO_EMAIL_SUFFIX}`, passwordHash: 'salt:hash', createdAt: '2026-01-01T00:00:00.000Z' }],
    stores: [{
      id: storeId, sellerId, slug, name: 'סטודיו לבוש', tagline: 't', description: 'd',
      colors: { primary: '#111827', accent: '#f97316' }, categories: ['בגדים'],
      shipping: { selfPickup: true }, profileImage: 'https://cdn.test/p.webp',
      address: 'דיזנגוף 112, תל אביב', addressVisible: true,
      hours: { sun: { closed: false, open: '09:00', close: '19:00' } }, hoursVisible: true,
      demo: over.demo ?? false, createdAt: '2026-01-02T00:00:00.000Z',
    }],
    categories: [{ id: categoryId, storeId, name: 'נשים', parentId: null, order: 0, createdAt: '2026-01-02T00:00:00.000Z' }],
    products: [{
      id: productId, storeId, slug: 'shirt-1', name: 'חולצה', description: 'd',
      price: 79.9, stock: 12, images: ['https://cdn.test/1.webp', 'https://cdn.test/2.webp'],
      categoryId, tags: ['חדש'],
      variants: [{ name: 'מידה', options: ['S', 'M'] }],
      variantStock: { [comboKey({ מידה: 'S' })]: 5, [comboKey({ מידה: 'M' })]: 7 },
      createdAt: '2026-01-03T00:00:00.000Z',
    }],
    // Two days of traffic sharing one visitor — enough to prove the seeded numbers reach the
    // performance tab AND that a returning visitor is not counted twice over the range.
    pageViews: [
      { storeId, day: '2026-01-10', total: 12, visitors: ['seed-a', 'seed-b'] },
      { storeId, day: '2026-01-11', total: 8, visitors: ['seed-a', 'seed-c'] },
    ],
    // Saved stores and wishlist entries are ROWS now, not the two counter files the demo seeder
    // wrote until buyer state moved (§5): three people saved the store, two of them also
    // wishlisted the shirt.
    favorites: [
      { userId: 'seed-buyer-1', storeId }, { userId: 'seed-buyer-2', storeId }, { userId: 'seed-buyer-3', storeId },
    ],
    wishlists: [
      { userId: 'seed-buyer-1', productId }, { userId: 'seed-buyer-2', productId },
    ],
    ids: { sellerId, storeId, categoryId, productId, slug },
  };
}

beforeEach(async () => {
  await purge(db, 'demo');
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

  // Same defence as the assertion above, for the half that moved with the page-view modules: the
  // seeder used to write data/store-pageviews.json, which nothing reads any more, so a seeded demo
  // store would have shown a performance tab with no traffic at all and reported success.
  it('produces traffic the performance tab can actually see', async () => {
    const set = catalog();
    await writeCatalog(db, set);

    const views = await getViewStatsForStore(set.ids.storeId, '2026-01-01', '2026-01-31', 'day');
    expect(views.totalViews).toBe(20);
    expect(views.totalUniqueVisitors).toBe(3);  // seed-a came back — 2 + 2 would be wrong
    expect(views.buckets).toEqual([
      { key: '2026-01-10', views: 12, uniqueVisitors: 2 },
      { key: '2026-01-11', views: 8, uniqueVisitors: 2 },
    ]);
  });

  // The last half-file the demo seeder still wrote. It seeded a favourite COUNT and a wishlist
  // COUNT into two JSON files — one of which had no live reader at all and the other of which was
  // keyed by bare product slug (§7.1) — so a freshly seeded demo store showed zeros on the two
  // figures the dashboard reads, and the script printed success. Same defence as the traffic
  // assertion above: read it back through the application's own readers, not through the tables.
  it('produces saved-store and wishlist figures the dashboard can actually see', async () => {
    const set = catalog();
    await writeCatalog(db, set);

    expect(await countFavoriteStores(set.ids.storeId)).toBe(3);
    expect(await getWishlistCountsForStore(set.ids.storeId)).toEqual({ 'shirt-1': 2 });
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
      purge: 'demo',
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
      purge: 'demo',
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

    const removed = await purge(db, 'demo');
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

/**
 * The journal has to leave with the orders it describes (owner, 2026-08-16 — he opened the admin
 * and found "48 אי-התאמות").
 *
 * `money_events.order_id` is TEXT with no foreign key, on purpose: an event can be recorded before
 * an order row exists. The cost is that nothing in the database stops a purge from stranding one,
 * and `reconcile.ts` reads a stranded `refund_due` as money a real buyer is still owed. The admin's
 * integrity banner then reports a debt that does not exist — permanently, after any re-seed — which
 * is the one failure that card is designed around: its clean state is deliberately quiet so the red
 * state keeps its weight.
 */
describe('purgeOrdersOfStores', () => {
  it('takes the money journal with the orders, by order id and by checkout ref', async () => {
    const seeded = catalog({ demo: true });
    const orderId = crypto.randomUUID();
    const ref = `ref-${crypto.randomBytes(4).toString('hex')}`;
    await writeCatalog(db, {
      ...seeded,
      orders: [{
        id: orderId, checkoutRef: ref, buyerName: 'דנה', buyerEmail: 'dana@example.com',
        buyerPhone: '050', buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
        shippingAmount: 30, totalAmount: 109.9, paymentStatus: 'paid', shippingStatus: 'delivered',
        items: [{ productId: seeded.ids.productId, productName: 'חולצה', storeSlug: seeded.ids.slug, price: 79.9, qty: 1 }],
        storeSubtotals: { [seeded.ids.slug]: { storeName: 'סטודיו לבוש', subtotal: 79.9, shipping: 30 } },
        createdAt: '2026-02-01T00:00:00.000Z',
      }],
    });

    // One event that names the order, and one that only knows the checkout ref — the shape a
    // payment attempt has before any order exists. Both have to go.
    await query(
      `INSERT INTO money_events (id, at, type, order_id, checkout_ref, amount_agorot, actor)
       VALUES ($1, now(), 'refund_due', $2, $3, 10990, 'system'),
              ($4, now(), 'payment_attempted', NULL, $3, 10990, 'system')`,
      [crypto.randomUUID(), orderId, ref, crypto.randomUUID()],
    );

    const removed = await purgeOrdersOfStores(db, 'demo');
    expect(removed.deleted).toBe(1);
    expect(removed.journalRows).toBe(2);

    const { rows } = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM money_events WHERE order_id = $1 OR checkout_ref = $2',
      [orderId, ref],
    );
    expect(rows[0]!.n).toBe(0);
  });

  /**
   * The shared-checkout case, one level down from the one the function already handled.
   *
   * A checkout writes one order PER STORE and they all carry the same `checkout_ref`, so a cart
   * mixing a demo store with a real one leaves two orders sharing it. The purge keeps the real one
   * — and a journal sweep written as "delete every event with this ref" would still take the kept
   * order's rows with it, leaving real money with an order and no record of how it got there.
   */
  it('keeps the journal of an order it deliberately did NOT delete, even on a shared checkout ref', async () => {
    const demo = catalog({ demo: true });
    const real = catalog({ email: `real-${crypto.randomBytes(3).toString('hex')}@example.com` });
    await writeCatalog(db, real);
    const sharedRef = `ref-${crypto.randomBytes(4).toString('hex')}`;
    const demoOrderId = crypto.randomUUID();
    const realOrderId = crypto.randomUUID();
    const order = (id: string, c: ReturnType<typeof catalog>) => ({
      id, checkoutRef: sharedRef, buyerName: 'דנה', buyerEmail: 'dana@example.com',
      buyerPhone: '050', buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
      shippingAmount: 30, totalAmount: 109.9, paymentStatus: 'paid', shippingStatus: 'delivered',
      items: [{ productId: c.ids.productId, productName: 'חולצה', storeSlug: c.ids.slug, price: 79.9, qty: 1 }],
      storeSubtotals: { [c.ids.slug]: { storeName: 'חנות', subtotal: 79.9, shipping: 30 } },
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    await writeCatalog(db, { ...demo, orders: [order(demoOrderId, demo), order(realOrderId, real)] });

    const keeper = crypto.randomUUID();
    await query(
      `INSERT INTO money_events (id, at, type, order_id, checkout_ref, amount_agorot, actor)
       VALUES ($1, now(), 'refund_due', $2, $3, 10990, 'system'),
              ($4, now(), 'payment_attempted', NULL, $3, 21980, 'system')`,
      [crypto.randomUUID(), demoOrderId, sharedRef, keeper],
    );

    await purgeOrdersOfStores(db, 'demo');

    // The real order survived, so the ref is still live and its pre-order event must stay.
    const kept = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM money_events WHERE id = $1', [keeper]);
    expect(kept.rows[0]!.n).toBe(1);
    const survivor = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM orders WHERE id = $1', [realOrderId]);
    expect(survivor.rows[0]!.n).toBe(1);

    await query('DELETE FROM money_events WHERE checkout_ref = $1', [sharedRef]);
  });
});

describe('purgeOrphanJournalRows', () => {
  it('clears events whose order is already gone, and touches nothing else', async () => {
    const orphanId = crypto.randomUUID();
    const keeperId = crypto.randomUUID();
    await query(
      `INSERT INTO money_events (id, at, type, order_id, amount_agorot, actor)
       VALUES ($1, now(), 'refund_due', $2, 5000, 'system'),
              ($3, now(), 'payment_attempted', NULL, 5000, 'system')`,
      [orphanId, crypto.randomUUID(), keeperId],
    );

    await purgeOrphanJournalRows(db);

    const gone = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM money_events WHERE id = $1', [orphanId]);
    expect(gone.rows[0]!.n).toBe(0);
    // An event with no order id at all is a legitimate record of a checkout that never became one.
    const kept = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM money_events WHERE id = $1', [keeperId]);
    expect(kept.rows[0]!.n).toBe(1);
  });
});
