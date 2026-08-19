/**
 * Store page-view counters against a real Postgres — the module DB_MIGRATION_PLAN.md §5 singles out
 * as the one that must NOT be translated one-to-one.
 *
 * **What the suite had before: one file, three tests, all about a read cache that no longer exists.**
 * `store-pageviews-cache.test.ts` did genuinely call `recordPageView` and `getDailyPageViews` — the
 * only bucket module with any real read/write coverage at all — but everything it asserted was that
 * an mtime-keyed cache over a JSON file invalidated correctly, and it wrote to `data/`, which is
 * gitignored and empty in CI. The cache went with the file. Meanwhile the one function that consumes
 * this module, `buildPerformanceSummary`, was tested with the module MOCKED
 * (`seller-performance.test.ts`), so a swap returning zero views for every store would have stayed
 * green.
 *
 * So this pins two different things:
 *
 * 1. **What the JSON version promised** — a repeat load by the same visitor raises the load count and
 *    not the visitor count; days outside the range do not count; a day whose stored value was a bare
 *    number (§7.3) still charts.
 *
 * 2. **What could only be got wrong in the move.** The unique-visitor count is the whole reason this
 *    module was not a one-to-one conversion: daily uniques CANNOT be summed into a monthly or
 *    range-wide figure, so the range total is its own `COUNT(DISTINCT …)`. The test that proves it is
 *    `across the range, a returning visitor is one person` — it fails against any implementation that
 *    adds the buckets up.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { businessDayISO } from '../src/lib/business-day.js';
import {
  EMPTY_VIEW_STATS,
  getStoreViewStats,
  getViewStatsForStore,
  recordPageView,
} from '../src/lib/store-pageviews.js';

const KERAMIKA = '22222222-2222-4222-8222-000000000001';

/** A store of this test's own, so counters written by one case cannot be read by another. */
let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `pv-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

/** Write a day's counters straight to the tables — for dated history a live `recordPageView`
 *  (which always writes TODAY, by design) cannot produce. */
async function seedDay(storeId: string, day: string, total: number, visitors: string[]): Promise<void> {
  await query(
    `INSERT INTO store_page_views (store_id, day, total) VALUES ($1, $2::date, $3)
     ON CONFLICT (store_id, day) DO UPDATE SET total = EXCLUDED.total`,
    [storeId, day, total],
  );
  for (const v of visitors) {
    await query(
      `INSERT INTO store_page_view_visitors (store_id, day, visitor_id) VALUES ($1, $2::date, $3)
       ON CONFLICT DO NOTHING`,
      [storeId, day, v],
    );
  }
}

/**
 * The business day, asked FRESH each time — never frozen at module load.
 *
 * **This is what turned CI red on 2026-08-20 at 00:0x local.** The constant used to be computed
 * when the file was imported, and every assertion then queried that day. A suite that starts before
 * midnight in Asia/Jerusalem and reaches these tests after it writes its page views into one day and
 * reads the other, so all three assertions come back 0 — with nothing in the message to suggest a
 * clock, and every one of them passing on a re-run five minutes later.
 *
 * A test that fails once a day, in the hour the people here actually work, is worse than a test that
 * fails always: it teaches everybody to re-run instead of read.
 */
const businessToday = () => businessDayISO(new Date());

describe('recordPageView — the write path that reads nothing', () => {
  it('counts a load and the visitor behind it', async () => {
    const storeId = await freshStore();
    await recordPageView(storeId, 'visitor-a');
    // Read AFTER the write, so the window cannot be one the write missed.
    const today = businessToday();
    const stats = await getViewStatsForStore(storeId, today, today, 'day');
    expect(stats.totalViews).toBe(1);
    expect(stats.totalUniqueVisitors).toBe(1);
    expect(stats.buckets).toEqual([{ key: today, views: 1, uniqueVisitors: 1 }]);
  });

  it('a returning visitor raises the load count and NOT the visitor count', async () => {
    const storeId = await freshStore();
    await recordPageView(storeId, 'visitor-a');
    await recordPageView(storeId, 'visitor-a');
    await recordPageView(storeId, 'visitor-b');
    const today = businessToday();
    const stats = await getViewStatsForStore(storeId, today, today, 'day');
    expect(stats.totalViews).toBe(3);
    expect(stats.totalUniqueVisitors).toBe(2);
  });

  it('still counts the load when no visitor id is known', async () => {
    const storeId = await freshStore();
    await recordPageView(storeId);
    await recordPageView(storeId, '');
    const today = businessToday();
    const stats = await getViewStatsForStore(storeId, today, today, 'day');
    expect(stats.totalViews).toBe(2);
    expect(stats.totalUniqueVisitors).toBe(0);
    // An empty visitor id must not become a row — `''` is "we don't know who", and a table full of
    // rows keyed on it would report one anonymous "person" who visited every store on the platform.
    const { rows } = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM store_page_view_visitors WHERE store_id = $1', [storeId]);
    expect(rows[0]!.n).toBe(0);
  });

  it('never throws on a store that does not exist, and writes nothing', async () => {
    const ghost = crypto.randomUUID();
    await expect(recordPageView(ghost, 'visitor-a')).resolves.toBeUndefined();
    await expect(recordPageView('not-a-uuid', 'visitor-a')).resolves.toBeUndefined();
    // The foreign key rejects the counter row; because both writes are one statement, the visitor
    // row cannot survive on its own either.
    const { rows } = await query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM store_page_view_visitors WHERE store_id = $1', [ghost]);
    expect(rows[0]!.n).toBe(0);
  });

  it('files the load on the BUSINESS day, not the server\'s UTC one (§7.8)', async () => {
    const storeId = await freshStore();
    await recordPageView(storeId, 'visitor-a');
    const { rows } = await query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM store_page_views WHERE store_id = $1`, [storeId]);
    // The application decides the date and passes it in. Between local midnight and 02:00/03:00
    // Israel time a UTC-derived day is the PREVIOUS one, which is how a visit and the purchase it
    // produced end up in different buckets.
    expect(rows[0]!.day).toBe(businessDayISO(new Date()));
  });
});

describe('getStoreViewStats — unique visitors are counted, never summed', () => {
  it('across the range, a returning visitor is one person', async () => {
    const storeId = await freshStore();
    await seedDay(storeId, '2026-07-10', 5, ['a', 'b']);
    await seedDay(storeId, '2026-07-11', 3, ['a', 'c']); // 'a' comes back the next day
    const stats = await getViewStatsForStore(storeId, '2026-07-01', '2026-07-31', 'day');
    expect(stats.totalViews).toBe(8);
    // 2 + 2 = 4 is what summing the buckets gives. The answer is 3.
    expect(stats.totalUniqueVisitors).toBe(3);
    expect(stats.buckets.map((b) => b.uniqueVisitors)).toEqual([2, 2]);
  });

  it('a month bucket counts each person once, however many days they came on', async () => {
    const storeId = await freshStore();
    await seedDay(storeId, '2026-05-02', 4, ['a', 'b']);
    await seedDay(storeId, '2026-05-20', 4, ['a', 'b']); // same two people, same month
    await seedDay(storeId, '2026-06-03', 4, ['a', 'd']);
    const stats = await getViewStatsForStore(storeId, '2026-05-01', '2026-07-31', 'month');
    expect(stats.buckets).toEqual([
      { key: '2026-05', views: 8, uniqueVisitors: 2 },  // a, b — not 4
      { key: '2026-06', views: 4, uniqueVisitors: 2 },  // a, d
    ]);
    expect(stats.totalUniqueVisitors).toBe(3); // a, b, d
  });

  it('includes both range bounds and excludes what falls outside them', async () => {
    const storeId = await freshStore();
    await seedDay(storeId, '2026-07-09', 1, ['x']);
    await seedDay(storeId, '2026-07-10', 2, ['a']);
    await seedDay(storeId, '2026-07-12', 4, ['b']);
    await seedDay(storeId, '2026-07-13', 8, ['y']);
    const stats = await getViewStatsForStore(storeId, '2026-07-10', '2026-07-12', 'day');
    expect(stats.totalViews).toBe(6);
    expect(stats.totalUniqueVisitors).toBe(2);
  });

  it('reports a day that has loads but no visitor ids at all', async () => {
    // The shape §7.3 measured: rows stored as a bare number, carrying a total and no ids. An inner
    // join between the two tables would drop the day entirely and understate the seller's traffic.
    const stats = await getViewStatsForStore(KERAMIKA, '2026-07-01', '2026-07-02', 'day');
    expect(stats.buckets).toEqual([
      { key: '2026-07-01', views: 5, uniqueVisitors: 0 },
      { key: '2026-07-02', views: 3, uniqueVisitors: 2 },
    ]);
    expect(stats.totalViews).toBe(8);
    expect(stats.totalUniqueVisitors).toBe(2);
  });

  it('returns counts as numbers — a bigint arrives as a string from pg (§8)', async () => {
    const stats = await getViewStatsForStore(KERAMIKA, '2026-07-01', '2026-07-02', 'day');
    expect(typeof stats.totalViews).toBe('number');
    expect(typeof stats.totalUniqueVisitors).toBe('number');
    expect(typeof stats.buckets[0]!.views).toBe('number');
    // The failure this guards is silent: `'5' + 3` is `'53'`, not 8.
    expect(stats.buckets[0]!.views + stats.buckets[1]!.views).toBe(8);
  });
});

describe('getStoreViewStats — every store in one query', () => {
  it('keeps each store\'s numbers to itself', async () => {
    const [a, b] = [await freshStore(), await freshStore()];
    await seedDay(a, '2026-07-10', 10, ['p', 'q']);
    await seedDay(b, '2026-07-10', 1, ['p']); // the same person visited both
    const stats = await getStoreViewStats([a, b], '2026-07-01', '2026-07-31', 'day');
    expect(stats.get(a)).toEqual({ buckets: [{ key: '2026-07-10', views: 10, uniqueVisitors: 2 }], totalViews: 10, totalUniqueVisitors: 2 });
    expect(stats.get(b)).toEqual({ buckets: [{ key: '2026-07-10', views: 1, uniqueVisitors: 1 }], totalViews: 1, totalUniqueVisitors: 1 });
  });

  it('omits a store with no traffic rather than inventing zeros for it', async () => {
    const quiet = await freshStore();
    const stats = await getStoreViewStats([quiet], '2026-07-01', '2026-07-31', 'day');
    expect(stats.has(quiet)).toBe(false);
    // Which is why the single-store reader answers with the empty value instead of undefined.
    expect(await getViewStatsForStore(quiet, '2026-07-01', '2026-07-31', 'day')).toEqual(EMPTY_VIEW_STATS);
  });

  it('answers an empty store list without touching the database', async () => {
    expect(await getStoreViewStats([], '2026-07-01', '2026-07-31', 'day')).toEqual(new Map());
  });

  it('answers "no data" for a day-shaped string that is not a day, instead of raising', async () => {
    // Postgres RAISES `date/time field value out of range` on these rather than matching nothing,
    // so a stale bookmark carrying one used to be a 500 on the page that asked. The shape is
    // settled before the query, exactly as `isUuid` settles an id (business-day.ts#isDayISO).
    for (const impossible of ['9999-99-99', '2026-02-30', '0000-00-00', 'yesterday']) {
      await expect(getViewStatsForStore(KERAMIKA, impossible, '2026-07-31', 'day'), impossible)
        .resolves.toEqual(EMPTY_VIEW_STATS);
      await expect(getViewStatsForStore(KERAMIKA, '2026-07-01', impossible, 'day'), impossible)
        .resolves.toEqual(EMPTY_VIEW_STATS);
    }
  });
});
