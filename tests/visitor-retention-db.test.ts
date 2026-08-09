/**
 * The retention purge for the only two tables in the schema that grow with TRAFFIC.
 *
 * Every other table is bounded by something: aggregated to a row per day (`analytics_daily`,
 * `store_page_views`), trimmed at write time (`error_log`), or already purged on a schedule
 * (`checkout_idempotency`, `auth_attempts`). `analytics_visitors` and `store_page_view_visitors`
 * write one row per person per day and nothing deleted them. `lib/visitor-retention.ts` carries the
 * window and why it is 400 days; this pins the three things the purge can get wrong, each of which
 * is silent — a deletion leaves no error behind, only a number that used to be bigger.
 *
 *  1. **It deletes strictly outside the window and nothing inside it.** The boundary day itself is
 *     KEPT, because the cutoff names the oldest day still readable and an off-by-one here quietly
 *     shortens the window every seller was promised.
 *
 *  2. **`AUX_EVENTS` survive at any age.** `getLifetimeEventSessions` counts DISTINCT visitors with
 *     no date bound — the seller-onboarding funnel's top is cumulative by design — so it is the one
 *     reader a purge could change. The test seeds a visit far outside the window and asserts the
 *     lifetime figure is untouched, which fails against the obvious implementation that deletes by
 *     date alone. (The tempting repair, a rolled-up counter, is wrong for a reason worth keeping in
 *     view: distinct counts do not add, so a visitor on both sides of the cutoff is counted twice
 *     and the "lifetime" number drifts upward at every purge — the direction that looks like growth.)
 *
 *  3. **It is idempotent**, the standing requirement for anything in `jobs/registry.ts`: the lease
 *     makes a double-run unlikely, not impossible.
 *
 * And one property that is not about the purge at all but is the reason it is safe to run: the
 * aggregate counters are untouched, so a range older than the window still reports its views in
 * full. That is the promise the admin note on the dashboard makes, asserted here rather than
 * believed.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../src/lib/db.js';
import { businessDayISO } from '../src/lib/business-day.js';
import { addDaysISO } from '../src/lib/date-range.js';
import {
  getEventTotals,
  getLifetimeEventSessions,
  purgeOldAnalyticsVisitors,
} from '../src/lib/analytics.js';
import { getViewStatsForStore, purgeOldStoreViewVisitors } from '../src/lib/store-pageviews.js';
import { VISITOR_RETENTION_DAYS, visitorRetentionCutoffISO } from '../src/lib/visitor-retention.js';

const today = businessDayISO(new Date());

/** The oldest day the window keeps, and one day older than that. */
const cutoff = visitorRetentionCutoffISO();
const tooOld = addDaysISO(cutoff, -1);

/** Unique per call, so two cases writing the same event on the same day never see each other's rows
 *  — these tables are shared and the purge is global by design. */
const vid = (): string => `ret-${crypto.randomBytes(8).toString('hex')}`;

async function seedAnalyticsVisitor(day: string, event: string, visitor: string): Promise<void> {
  await query(
    `INSERT INTO analytics_visitors (day, event, visitor_id) VALUES ($1::date, $2, $3)
     ON CONFLICT DO NOTHING`,
    [day, event, visitor],
  );
}

async function analyticsVisitorExists(day: string, visitor: string): Promise<boolean> {
  const { rowCount } = await query(
    'SELECT 1 FROM analytics_visitors WHERE day = $1::date AND visitor_id = $2',
    [day, visitor],
  );
  return rowCount > 0;
}

let seq = 0;
async function freshStore(): Promise<string> {
  seq += 1;
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `ret-test-${seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return storeId;
}

async function seedStoreDay(storeId: string, day: string, total: number, visitors: string[]): Promise<void> {
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

describe('the retention window itself', () => {
  it('names a cutoff exactly VISITOR_RETENTION_DAYS behind the business day', () => {
    expect(cutoff).toBe(addDaysISO(today, -VISITOR_RETENTION_DAYS));
  });

  it('is derived from the business calendar, not the database — a fixed date gives a fixed cutoff', () => {
    // The server runs UTC and the platform's day is Asia/Jerusalem; a CURRENT_DATE in the SQL would
    // cut on the wrong calendar for a few hours every night. Pinning an instant proves the cutoff
    // follows the argument rather than the clock.
    const stamped = new Date('2026-08-09T12:00:00+03:00');
    expect(visitorRetentionCutoffISO(stamped)).toBe(addDaysISO(businessDayISO(stamped), -VISITOR_RETENTION_DAYS));
  });
});

describe('purgeOldAnalyticsVisitors', () => {
  it('keeps the boundary day and drops the one before it', async () => {
    const kept = vid();
    const dropped = vid();
    await seedAnalyticsVisitor(cutoff, 'page_view', kept);
    await seedAnalyticsVisitor(tooOld, 'page_view', dropped);

    await purgeOldAnalyticsVisitors(cutoff);

    expect(await analyticsVisitorExists(cutoff, kept)).toBe(true);
    expect(await analyticsVisitorExists(tooOld, dropped)).toBe(false);
  });

  it('never touches an AUX event, however old — the lifetime funnel count is unbounded by design', async () => {
    const visitor = vid();
    await seedAnalyticsVisitor(tooOld, 'seller_register_view', visitor);
    const before = await getLifetimeEventSessions('seller_register_view');

    await purgeOldAnalyticsVisitors(cutoff);

    expect(await analyticsVisitorExists(tooOld, visitor)).toBe(true);
    expect(await getLifetimeEventSessions('seller_register_view')).toBe(before);
  });

  it('leaves the aggregate day counts alone — an old range still reports its volume', async () => {
    await query(
      `INSERT INTO analytics_daily (day, event, count) VALUES ($1::date, 'page_view', 7)
       ON CONFLICT (day, event) DO UPDATE SET count = EXCLUDED.count`,
      [tooOld],
    );
    await seedAnalyticsVisitor(tooOld, 'page_view', vid());

    await purgeOldAnalyticsVisitors(cutoff);

    const totals = await getEventTotals(tooOld, tooOld);
    expect(totals.page_view?.count).toBe(7);
    // The uniques for that range are gone — that is the whole and only cost of the window.
    expect(totals.page_view?.sessions).toBe(0);
  });

  it('is idempotent — a second pass deletes nothing', async () => {
    await seedAnalyticsVisitor(tooOld, 'page_view', vid());
    await purgeOldAnalyticsVisitors(cutoff);
    expect(await purgeOldAnalyticsVisitors(cutoff)).toBe(0);
  });

  it('refuses a malformed day rather than deleting on a value Postgres would coerce', async () => {
    await expect(purgeOldAnalyticsVisitors('not-a-day')).rejects.toThrow();
  });
});

describe('purgeOldStoreViewVisitors', () => {
  it('drops visitor rows outside the window and keeps the view counts', async () => {
    const storeId = await freshStore();
    await seedStoreDay(storeId, tooOld, 12, [vid(), vid()]);

    await purgeOldStoreViewVisitors(cutoff);

    const stats = await getViewStatsForStore(storeId, tooOld, tooOld, 'day');
    expect(stats.totalViews).toBe(12);
    expect(stats.totalUniqueVisitors).toBe(0);
  });

  it('keeps everything inside the window', async () => {
    const storeId = await freshStore();
    await seedStoreDay(storeId, cutoff, 3, [vid(), vid()]);

    await purgeOldStoreViewVisitors(cutoff);

    const stats = await getViewStatsForStore(storeId, cutoff, cutoff, 'day');
    expect(stats.totalViews).toBe(3);
    expect(stats.totalUniqueVisitors).toBe(2);
  });

  it('is idempotent — a second pass deletes nothing', async () => {
    const storeId = await freshStore();
    await seedStoreDay(storeId, tooOld, 1, [vid()]);
    await purgeOldStoreViewVisitors(cutoff);
    expect(await purgeOldStoreViewVisitors(cutoff)).toBe(0);
  });

  it('refuses a malformed day', async () => {
    await expect(purgeOldStoreViewVisitors('2026-13-99x')).rejects.toThrow();
  });
});

/**
 * The guard, and the reason it scans the tree rather than a list of files.
 *
 * The dangerous change is not to the code above — it is a SECOND deletion written somewhere else
 * later, by someone who did not read `purgeOldAnalyticsVisitors` and therefore did not know that
 * `AUX_EVENTS` must survive. That copy would pass every test in this file, delete the rows the
 * cumulative seller funnel counts, and the only symptom would be a number on the admin dashboard
 * that is smaller than it was. Nothing would fail. The same pattern as `money-guards` and
 * `safe-redirect`: the rule is enforced by there being exactly one place that can break it.
 */
describe('only one module may delete from each visitor table', () => {
  const SRC = path.resolve(process.cwd(), 'src');

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.(ts|astro)$/.test(e.name) ? [full] : [];
    });
  }

  const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') }));

  it.each([
    ['analytics_visitors', 'lib/analytics.ts'],
    ['store_page_view_visitors', 'lib/store-pageviews.ts'],
  ])('deletes from %s only in %s', (table, owner) => {
    const re = new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i');
    const offenders = files
      .filter((f) => re.test(f.text))
      .map((f) => f.rel.split(path.sep).join('/'));
    expect(offenders).toEqual([owner]);
  });

  it('keeps the retention window in exactly one place', () => {
    // A second literal 400 beside one of these tables is a window that disagrees with the one the
    // dashboard promises, and disagreement is invisible until someone compares two screens.
    const offenders = files
      .filter((f) => f.rel !== 'lib/visitor-retention.ts')
      .filter((f) => /VISITOR_RETENTION_DAYS\s*=/.test(f.text))
      .map((f) => f.rel.split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
