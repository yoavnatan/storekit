/**
 * Per-product view counters against a real Postgres — moved in the same diff as `store-pageviews`
 * (DB_MIGRATION_PLAN.md §5, §8) because one function, `buildProductPerformance`'s caller, reads both.
 *
 * **Previous coverage: none.** `seller-performance.test.ts` mocked this module outright, so a swap
 * that returned zero views for every product would have been invisible.
 *
 * The behaviour worth pinning is the deliberate DIFFERENCE from the store-level twin: a product view
 * has no visitor set, so a repeat view by the same person counts again. That is the intent — the
 * drill-down asks "how many times was this looked at" — and it is exactly the kind of thing a later
 * reader would "fix" into a distinct count.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { businessDayISO } from '../src/lib/business-day.js';
import {
  EMPTY_PRODUCT_VIEW_STATS,
  getProductViewStats,
  recordProductView,
} from '../src/lib/product-pageviews.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const IMPORTED_PRODUCT = '44444444-4444-4444-8444-000000000001';

let seq = 0;
async function freshProduct(): Promise<string> {
  seq += 1;
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
     VALUES ($1, $2, $3, 'T', 100, 1)`,
    [id, KERAMIKA, `pv-prod-${seq}-${crypto.randomBytes(3).toString('hex')}`],
  );
  return id;
}

async function seedDay(productId: string, day: string, total: number): Promise<void> {
  await query(
    `INSERT INTO product_page_views (product_id, day, total) VALUES ($1, $2::date, $3)
     ON CONFLICT (product_id, day) DO UPDATE SET total = EXCLUDED.total`,
    [productId, day, total],
  );
}

/** Asked FRESH, never frozen at module load — a suite that crosses midnight in Asia/Jerusalem
 *  otherwise writes into one business day and reads the other, and every assertion comes back 0
 *  with nothing in the message to suggest a clock. Turned CI red on 2026-08-20 at 00:0x in
 *  `store-pageviews-db.test.ts`, which carries the full note. */
const businessToday = () => businessDayISO(new Date());

describe('recordProductView', () => {
  it('counts every view, including repeats by the same person', async () => {
    const productId = await freshProduct();
    await recordProductView(productId);
    await recordProductView(productId);
    await recordProductView(productId);
    const stats = await getProductViewStats(productId, businessToday(), businessToday(), 'day');
    // Not a distinct count, on purpose — see this file's header.
    expect(stats.totalViews).toBe(3);
    expect(stats.buckets).toEqual([{ key: businessToday(), views: 3 }]);
  });

  it('files the view on the business day the application decided (§7.8)', async () => {
    const productId = await freshProduct();
    await recordProductView(productId);
    const { rows } = await query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM product_page_views WHERE product_id = $1`, [productId]);
    expect(rows[0]!.day).toBe(businessDayISO(new Date()));
  });

  it('never throws on a product that does not exist or an id that is not a uuid', async () => {
    // The second one matters more than it looks: Postgres REJECTS a malformed uuid literal rather
    // than failing to match it, so without the shape check an id from a stale URL is a 500.
    await expect(recordProductView(crypto.randomUUID())).resolves.toBeUndefined();
    await expect(recordProductView('product-7')).resolves.toBeUndefined();
    await expect(recordProductView('')).resolves.toBeUndefined();
  });
});

describe('getProductViewStats', () => {
  it('buckets by day and by month, and sums the range', async () => {
    const productId = await freshProduct();
    await seedDay(productId, '2026-05-02', 4);
    await seedDay(productId, '2026-05-20', 6);
    await seedDay(productId, '2026-06-03', 5);

    const byDay = await getProductViewStats(productId, '2026-05-01', '2026-06-30', 'day');
    expect(byDay.buckets).toEqual([
      { key: '2026-05-02', views: 4 },
      { key: '2026-05-20', views: 6 },
      { key: '2026-06-03', views: 5 },
    ]);
    expect(byDay.totalViews).toBe(15);

    const byMonth = await getProductViewStats(productId, '2026-05-01', '2026-06-30', 'month');
    expect(byMonth.buckets).toEqual([
      { key: '2026-05', views: 10 },
      { key: '2026-06', views: 5 },
    ]);
    expect(byMonth.totalViews).toBe(15);
  });

  it('includes both range bounds and excludes what falls outside them', async () => {
    const productId = await freshProduct();
    await seedDay(productId, '2026-07-09', 1);
    await seedDay(productId, '2026-07-10', 2);
    await seedDay(productId, '2026-07-12', 4);
    await seedDay(productId, '2026-07-13', 8);
    const stats = await getProductViewStats(productId, '2026-07-10', '2026-07-12', 'day');
    expect(stats.totalViews).toBe(6);
  });

  it('reads what the import wrote, whatever shape the JSON stored it in (§7.3)', async () => {
    // The fixture holds one day as `{ total, visitors }` and the next as a bare `4`.
    const stats = await getProductViewStats(IMPORTED_PRODUCT, '2026-07-01', '2026-07-02', 'day');
    expect(stats.buckets).toEqual([
      { key: '2026-07-01', views: 2 },
      { key: '2026-07-02', views: 4 },
    ]);
    expect(stats.totalViews).toBe(6);
    // `SUM` of an integer column is bigint — a string from pg, a number from PGlite (§8).
    expect(typeof stats.totalViews).toBe('number');
  });

  it('answers "no data" for a day-shaped string that is not a day, instead of raising', async () => {
    // Same guard as the store-level twin — Postgres raises on these rather than matching nothing.
    for (const impossible of ['9999-99-99', '2026-02-30', '2026-13-01']) {
      await expect(getProductViewStats(IMPORTED_PRODUCT, impossible, '2026-07-31', 'day'), impossible)
        .resolves.toEqual(EMPTY_PRODUCT_VIEW_STATS);
      await expect(getProductViewStats(IMPORTED_PRODUCT, '2026-07-01', impossible, 'day'), impossible)
        .resolves.toEqual(EMPTY_PRODUCT_VIEW_STATS);
    }
  });

  it('answers with no views for an unknown product, and for an id that is not a uuid', async () => {
    expect(await getProductViewStats(crypto.randomUUID(), '2026-07-01', '2026-07-31', 'day'))
      .toEqual(EMPTY_PRODUCT_VIEW_STATS);
    expect(await getProductViewStats('deleted-product-id', '2026-07-01', '2026-07-31', 'day'))
      .toEqual(EMPTY_PRODUCT_VIEW_STATS);
  });
});
