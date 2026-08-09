import { rows, query } from './db.js';

/**
 * Store page-view counters — how many loads a storefront got, and how many different people.
 *
 * **Moved to Postgres (DB_MIGRATION_PLAN.md §5, §8).** This is the module the plan singles out as
 * the one that must NOT be translated one-to-one. The JSON version kept, per store per day, an
 * object `{ total, visitors: [...] }` where `visitors` was the array of every distinct visitor id
 * seen that day — read in full and written back in full on EVERY page load. One busy day already
 * held 173 ids in the measured data; at 10,000 visitors a day that is a 10,000-element array
 * rewritten per request. Copying that array into a table would have kept the defect and added a
 * network hop.
 *
 * What it is instead:
 *
 * · **A write is two INSERTs that read nothing.** `store_page_views` carries the load counter and
 *   `store_page_view_visitors` carries one row per (store, day, visitor) — so recording a view is
 *   `ON CONFLICT DO UPDATE total = total + 1` plus `ON CONFLICT DO NOTHING`, in ONE statement
 *   (a data-modifying CTE), one round trip, no prior SELECT. Nothing is ever read in order to write,
 *   which is the property that makes this safe on the hottest path in the application.
 *
 * · **"Unique visitors" is `COUNT(DISTINCT visitor_id)`, computed in the database, and the array
 *   never leaves it.** This is why the read API below is shaped by BUCKET rather than by day: daily
 *   unique counts cannot be summed into a monthly one (a visitor returning on two days is one
 *   person, not two), so the caller's bucket size has to reach the `GROUP BY`. Returning per-day
 *   rows and letting the caller union them would just move the unbounded array into the result set.
 *
 * · **Keyed by store id, not slug.** The consequence is that a store renaming its URL no longer
 *   needs its analytics migrated at all — `renameStoreSlugInPageviews` existed only because the
 *   JSON was keyed by slug, and it is gone.
 *
 * **`day` is a DATE the APPLICATION decides (§7.8).** The server runs in UTC and the business
 * calendar is Asia/Jerusalem, so a day boundary derived in the database would sit three hours off
 * every report. `businessDayISO` supplies it on write and callers pass 'YYYY-MM-DD' bounds on read;
 * no query here does timezone arithmetic, deliberately.
 */

import { isDayISO } from './business-day.js';
import { recordPageViewTap } from './page-view-tap.js';

/** Bucket size for a reported series. Day buckets key on 'YYYY-MM-DD', month buckets on 'YYYY-MM'. */
export type ViewGranularity = 'day' | 'month';

export interface ViewBucket {
  /** 'YYYY-MM-DD' or 'YYYY-MM' — the same key `seller-performance.ts` lays its x-axis out with. */
  key: string;
  /** Total loads in this bucket, repeat visits included. */
  views: number;
  /** Distinct visitor ids in this bucket — counted by the database, never unioned here. */
  uniqueVisitors: number;
}

export interface StoreViewStats {
  buckets: ViewBucket[];
  totalViews: number;
  /**
   * Distinct visitors across the WHOLE range. Deliberately not derivable from `buckets`: summing
   * per-bucket uniques double-counts everyone who came back, which is exactly the number this
   * metric exists to distinguish.
   */
  totalUniqueVisitors: number;
}

export const EMPTY_VIEW_STATS: StoreViewStats = { buckets: [], totalViews: 0, totalUniqueVisitors: 0 };

/** The `to_char` pattern that turns a `date` into the caller's bucket key. */
function bucketFormat(granularity: ViewGranularity): string {
  return granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
}

/**
 * Record one load of a storefront, and the visitor behind it when one is known.
 *
 * Fire-and-forget from `middleware.ts`, so it NEVER throws and never rejects: an analytics tap that
 * can fail a page render is worse than one that occasionally loses a count. Callers use `void`.
 *
 * The two writes are one statement. A data-modifying `WITH` clause always executes, whether or not
 * the outer query reads it, which is what lets the counter bump and the visitor row travel together
 * without a transaction's extra BEGIN/COMMIT round trips on the hottest path in the app.
 */
export async function recordPageView(storeId: string, visitorId?: string): Promise<void> {
  // The statement lives in `page-view-tap.ts` — a store page view never happens alone (the funnel
  // page_view, and on a product page two more writes, all land on the same request), so all of them
  // are one round trip there rather than four here. This is the store-only entrance to it.
  await recordPageViewTap({ storeId, visitorId });
}

interface BucketRow { store_id: string; bucket: string; views: number | string; uniques: number | string }
interface TotalRow { store_id: string; uniques: number | string }

/** `COUNT` and `SUM` come back as `bigint` — a string from `pg`, a number from PGlite (§8). */
const count = (v: number | string | null): number => Number(v ?? 0);

/**
 * View statistics for several stores at once, over [fromISO, toISO] inclusive, bucketed by
 * `granularity`.
 *
 * **Several stores in one call is the whole signature.** The admin performance tab aggregates every
 * store on the platform (`platform-performance.ts`), which in the JSON era was one file read per
 * store — 45 of them per render, and the reason a read cache had to be bolted onto this module at
 * all. One query per store would have been 45 pool checkouts instead. Here the store list is one
 * `= ANY($1)`, and a single store is simply an array of one.
 *
 * Two statements rather than one: bucket rows join loads to uniques, and the range total needs its
 * OWN `COUNT(DISTINCT …)` for the reason spelled out on `totalUniqueVisitors`. They are independent,
 * so they go out together.
 */
export async function getStoreViewStats(
  storeIds: readonly string[],
  fromISO: string,
  toISO: string,
  granularity: ViewGranularity,
): Promise<Map<string, StoreViewStats>> {
  const result = new Map<string, StoreViewStats>();
  // A day that does not exist is not a narrower range, it is a value Postgres refuses to cast —
  // `2026-02-30` and `9999-99-99` both have the right shape and raise rather than match. Same rule
  // as `isUuid` before an id lookup: settle the shape here so a stale bookmark stays "no data"
  // instead of becoming a 500 on the page that asked. Routes reject these with a 400 first.
  if (storeIds.length === 0 || !isDayISO(fromISO) || !isDayISO(toISO)) return result;
  const window = [storeIds, fromISO, toISO];
  const bucketed = [...window, bucketFormat(granularity)];

  const [bucketRows, totalRows] = await Promise.all([
    // FULL JOIN, not INNER: a day can hold loads with no visitor ids at all (rows imported from the
    // era before ids were captured store a bare total), and the reverse is possible after a
    // counter is corrected. Either side alone is still a real bucket.
    rows<BucketRow>(
      `WITH loads AS (
         SELECT store_id, to_char(day, $4::text) AS bucket, SUM(total) AS views
           FROM store_page_views
          WHERE store_id = ANY($1::uuid[]) AND day >= $2::date AND day <= $3::date
          GROUP BY store_id, to_char(day, $4::text)
       ), people AS (
         SELECT store_id, to_char(day, $4::text) AS bucket, COUNT(DISTINCT visitor_id) AS uniques
           FROM store_page_view_visitors
          WHERE store_id = ANY($1::uuid[]) AND day >= $2::date AND day <= $3::date
          GROUP BY store_id, to_char(day, $4::text)
       )
       SELECT COALESCE(l.store_id, p.store_id) AS store_id,
              COALESCE(l.bucket, p.bucket)     AS bucket,
              COALESCE(l.views, 0)             AS views,
              COALESCE(p.uniques, 0)           AS uniques
         FROM loads l
         FULL JOIN people p ON p.store_id = l.store_id AND p.bucket = l.bucket
        ORDER BY 2`,
      bucketed,
    ),
    rows<TotalRow>(
      `SELECT store_id, COUNT(DISTINCT visitor_id) AS uniques
         FROM store_page_view_visitors
        WHERE store_id = ANY($1::uuid[]) AND day >= $2::date AND day <= $3::date
        GROUP BY store_id`,
      window,
    ),
  ]);

  const statsFor = (storeId: string): StoreViewStats => {
    let stats = result.get(storeId);
    if (!stats) { stats = { buckets: [], totalViews: 0, totalUniqueVisitors: 0 }; result.set(storeId, stats); }
    return stats;
  };

  for (const row of bucketRows) {
    const stats = statsFor(row.store_id);
    const views = count(row.views);
    stats.buckets.push({ key: row.bucket, views, uniqueVisitors: count(row.uniques) });
    stats.totalViews += views;
  }
  for (const row of totalRows) statsFor(row.store_id).totalUniqueVisitors = count(row.uniques);

  return result;
}

/**
 * Drop per-visitor rows older than the retention window (`visitor-retention.ts` holds the window and
 * the reasoning; GO_LIVE §6 holds the owner decision).
 *
 * **Safe without exception, and it is worth saying why this one needs no carve-out.** Every reader
 * of `store_page_view_visitors` in the application is inside `getStoreViewStats` above, and both of
 * its queries bound `day` on the caller's range — there is no lifetime or unbounded count of this
 * table anywhere. So a row outside the window cannot reach a screen, and deleting it changes no
 * number anyone can ask for. (`analytics_visitors` is not like this and carries an exclusion — see
 * `analytics.ts#purgeOldAnalyticsVisitors`.)
 *
 * `store_page_views` — the counts themselves — is deliberately untouched and kept forever. It is one
 * row per store per day and it is what a range older than the window still reports correctly.
 */
export async function purgeOldStoreViewVisitors(cutoffDayISO: string): Promise<number> {
  if (!isDayISO(cutoffDayISO)) throw new Error(`purgeOldStoreViewVisitors: bad day ${cutoffDayISO}`);
  const { rowCount } = await query(
    'DELETE FROM store_page_view_visitors WHERE day < $1::date',
    [cutoffDayISO],
  );
  return rowCount;
}

/** The single-store case, which is what every seller-facing surface needs. */
export async function getViewStatsForStore(
  storeId: string,
  fromISO: string,
  toISO: string,
  granularity: ViewGranularity,
): Promise<StoreViewStats> {
  return (await getStoreViewStats([storeId], fromISO, toISO, granularity)).get(storeId) ?? EMPTY_VIEW_STATS;
}
