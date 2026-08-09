import { rows, query } from './db.js';
import { recordPageViewTap } from './page-view-tap.js';

/**
 * First-party funnel analytics — the buyer's path from landing on the site to paying.
 *
 * **Moved to Postgres (DB_MIGRATION_PLAN.md §5, §8).** The JSON version held, per day per event, an
 * object `{ count, visitors: [...], products: {...} }` — where `visitors` was the array of every
 * session id that fired the event that day. One measured day already carried 359 ids for
 * `page_view` alone, and the whole file was read and rewritten on every page load, because the
 * middleware records a `page_view` for each one.
 *
 * Three properties replace it, and none of them is a copy of the old shape:
 *
 * · **A write is one statement that reads nothing.** `analytics_daily` carries the volume counter,
 *   `analytics_visitors` one row per (day, event, session), `analytics_products` the per-product
 *   tally — all three move in a single data-modifying CTE, one round trip, no prior SELECT.
 *
 * · **A funnel stage is `COUNT(DISTINCT visitor_id)` OVER THE RANGE, computed in the database.**
 *   This is why the read API hands the pure layer one already-aggregated total per event rather than
 *   per-day rows: daily unique counts cannot be summed into a range (a session that returns
 *   tomorrow is one session, not two), so a caller that unioned day rows would just be moving the
 *   unbounded visitor array out of the file and into a result set.
 *
 * · **The product breakdowns rank inside the database.** `topProductsByEvent` and
 *   `topAbandonedProducts` are `GROUP BY` + `ORDER BY` + `LIMIT`; shipping every product's tally to
 *   JavaScript to pick eight of them is the same unbounded read in a different costume.
 *
 * What stays pure and synchronous is what is actually arithmetic: the funnel's stage list and every
 * rate derived from it (`buildFunnel` / `buildAnalyticsRates`). They take `EventTotals` as INPUT —
 * the same move that kept `buildPerformanceSummary` testable without a database when page-views
 * moved — so the numbers that appear on the admin's screen are still unit-tested without one.
 *
 * **`day` is a DATE the APPLICATION decides (§7.8).** The server runs in UTC and the business
 * calendar is Asia/Jerusalem; `businessDayISO` supplies the day on write and callers pass
 * 'YYYY-MM-DD' bounds on read. No query here derives a day of its own.
 */

import { isDayISO } from './business-day.js';

// The buyer funnel, ordered top → bottom. Each is a FIRST-PARTY event we capture
// ourselves — deliberately independent of the GTM/Meta dataLayer, which only
// forwards events to third parties and stores nothing we can query for our own
// business insights. 'page_view' is the top (any HTML page load); each later
// stage narrows toward a completed purchase.
export const FUNNEL_EVENTS = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'] as const;
// Events captured the same way but OUTSIDE the buyer funnel — currently the top
// of the SELLER onboarding funnel (a visit to the seller registration page). Kept
// in the same tables; buildFunnel() iterates only FUNNEL_EVENTS.
export const AUX_EVENTS = ['seller_register_view'] as const;
export type FunnelEvent = typeof FUNNEL_EVENTS[number];
export type AnalyticsEvent = FunnelEvent | typeof AUX_EVENTS[number];

/** `COUNT` and `SUM` come back as `bigint` — a string from `pg`, a number from PGlite (§8). */
const count = (v: number | string | null): number => Number(v ?? 0);

export interface RecordOpts { vid?: string; productIds?: string[] }

/**
 * Fire-and-forget event record: bumps the day's volume for `type`, files the session id once
 * (repeat fires by the same session never inflate a funnel stage), and tallies each product id.
 *
 * NEVER throws and never rejects — this runs on every page load from `middleware.ts` and at the end
 * of checkout, and an analytics tap that can fail a render is worse than one that loses a count.
 * Callers use `void`.
 *
 * **The three tables move in one statement, and since 2026-08-03 so does everything else a page view
 * writes.** The statement itself lives in `page-view-tap.ts`, because a page load also counts a
 * store view and a product view and those were three more round trips on the hottest path in the
 * application. This is the single-event entrance to it — unchanged for every caller, and the only
 * copy of the SQL is over there.
 */
export async function recordAnalyticsEvent(type: AnalyticsEvent, opts: RecordOpts = {}): Promise<void> {
  await recordPageViewTap({
    events: [type],
    visitorId: opts.vid,
    productEvent: type,
    productIds: opts.productIds,
  });
}

// ── Pure aggregation (takes already-aggregated totals, no I/O — directly unit-testable) ──

/** One event's two measurements over a range: distinct sessions, and raw volume. */
export interface StageTotals { sessions: number; count: number }

/**
 * Per-event totals for ONE window, as the database returned them.
 *
 * Deliberately not per-day: `sessions` is a distinct count over the whole range and is not
 * recoverable from daily figures. An event with no traffic in the window is simply absent.
 */
export type EventTotals = Partial<Record<AnalyticsEvent, StageTotals>>;

const NO_TOTALS: StageTotals = { sessions: 0, count: 0 };

export interface FunnelStage { event: FunnelEvent; sessions: number; count: number }

/** The buyer funnel: one stage per FUNNEL_EVENTS entry, in order, measured in sessions. */
export function buildFunnel(totals: EventTotals): FunnelStage[] {
  return FUNNEL_EVENTS.map((event) => {
    const t = totals[event] ?? NO_TOTALS;
    return { event, sessions: t.sessions, count: t.count };
  });
}

export interface AnalyticsRates {
  sessions: number;
  productViews: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
  bounceRate: number;             // sessions that never viewed a product (landed + left)
  cartAbandonmentRate: number;    // added to cart but never purchased
  checkoutAbandonmentRate: number;// reached checkout but never purchased
  conversionRate: number;         // purchasing sessions / all sessions
}

const rate = (part: number, whole: number): number => (whole > 0 ? Math.max(0, Math.min(1, part / whole)) * 100 : 0);

export function buildAnalyticsRates(totals: EventTotals): AnalyticsRates {
  const sessionsOf = (event: AnalyticsEvent): number => (totals[event] ?? NO_TOTALS).sessions;
  const sessions = sessionsOf('page_view');
  const productViews = sessionsOf('view_item');
  const addToCarts = sessionsOf('add_to_cart');
  const checkouts = sessionsOf('begin_checkout');
  const purchases = sessionsOf('purchase');
  return {
    sessions, productViews, addToCarts, checkouts, purchases,
    bounceRate: rate(sessions - productViews, sessions),
    cartAbandonmentRate: rate(addToCarts - purchases, addToCarts),
    checkoutAbandonmentRate: rate(checkouts - purchases, checkouts),
    conversionRate: rate(purchases, sessions),
  };
}

// ── Queries ──

interface TotalsRow { event: string; sessions: number | string; count: number | string }

/**
 * Distinct sessions and raw volume per event over [fromISO, toISO] inclusive.
 *
 * A day that does not exist is not a narrower range, it is a value Postgres refuses to cast —
 * `2026-02-30` and `9999-99-99` both have the right shape and raise rather than match. Settling the
 * shape here keeps a stale bookmark at "no data" instead of turning it into a 500 (§8, `isDayISO`).
 */
export async function getEventTotals(fromISO: string, toISO: string): Promise<EventTotals> {
  const totals: EventTotals = {};
  if (!isDayISO(fromISO) || !isDayISO(toISO)) return totals;
  // FULL JOIN, not INNER: a day can hold volume with no session ids at all (rows recorded before
  // the visitor cookie existed store a bare count), and after a correction the reverse is possible.
  // Either side alone is still a real measurement of that event.
  const result = await rows<TotalsRow>(
    `WITH volume AS (
       SELECT event, SUM(count) AS count
         FROM analytics_daily
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY event
     ), people AS (
       SELECT event, COUNT(DISTINCT visitor_id) AS sessions
         FROM analytics_visitors
        WHERE day >= $1::date AND day <= $2::date
        GROUP BY event
     )
     SELECT COALESCE(v.event, p.event) AS event,
            COALESCE(p.sessions, 0)    AS sessions,
            COALESCE(v.count, 0)       AS count
       FROM volume v
       FULL JOIN people p ON p.event = v.event`,
    [fromISO, toISO],
  );
  for (const row of result) {
    totals[row.event as AnalyticsEvent] = { sessions: count(row.sessions), count: count(row.count) };
  }
  return totals;
}

export interface ProductStat { productId: string; count: number }

interface ProductRow { product_id: string; count: number | string }

/**
 * Top product ids by occurrences of `type` (e.g. most added-to-cart) across a range.
 *
 * The ordering tie-breaks on the id so that products with equal tallies come back in a stable order
 * — otherwise the eight that survive `LIMIT` change between two renders of the same window.
 */
export async function getTopProductsByEvent(
  type: AnalyticsEvent,
  fromISO: string,
  toISO: string,
  limit = 8,
): Promise<ProductStat[]> {
  if (!isDayISO(fromISO) || !isDayISO(toISO)) return [];
  const result = await rows<ProductRow>(
    `SELECT product_id, SUM(count) AS count
       FROM analytics_products
      WHERE event = $1 AND day >= $2::date AND day <= $3::date
      GROUP BY product_id
      ORDER BY SUM(count) DESC, product_id
      LIMIT $4`,
    [type, fromISO, toISO, limit],
  );
  return result.map((row) => ({ productId: row.product_id, count: count(row.count) }));
}

export interface AbandonedProduct { productId: string; added: number; purchased: number; abandoned: number }

interface AbandonedRow { product_id: string; added: number | string; purchased: number | string; abandoned: number | string }

/**
 * Products added to carts but not bought — the demand-vs-conversion gap, per product.
 *
 * The subtraction happens BEFORE the `LIMIT`, which is the whole reason this is one query and not
 * two calls to the function above: a product that is added constantly and always bought has no gap
 * at all, and ranking by adds first would spend slots in the top eight on products with nothing to
 * report.
 */
export async function getTopAbandonedProducts(
  fromISO: string,
  toISO: string,
  limit = 8,
): Promise<AbandonedProduct[]> {
  if (!isDayISO(fromISO) || !isDayISO(toISO)) return [];
  const result = await rows<AbandonedRow>(
    `WITH added AS (
       SELECT product_id, SUM(count) AS n
         FROM analytics_products
        WHERE event = 'add_to_cart' AND day >= $1::date AND day <= $2::date
        GROUP BY product_id
     ), bought AS (
       SELECT product_id, SUM(count) AS n
         FROM analytics_products
        WHERE event = 'purchase' AND day >= $1::date AND day <= $2::date
        GROUP BY product_id
     )
     SELECT a.product_id,
            a.n                          AS added,
            COALESCE(b.n, 0)             AS purchased,
            a.n - COALESCE(b.n, 0)       AS abandoned
       FROM added a
       LEFT JOIN bought b ON b.product_id = a.product_id
      WHERE a.n > COALESCE(b.n, 0)
      ORDER BY abandoned DESC, a.product_id
      LIMIT $3`,
    [fromISO, toISO, limit],
  );
  return result.map((row) => ({
    productId: row.product_id,
    added: count(row.added),
    purchased: count(row.purchased),
    abandoned: count(row.abandoned),
  }));
}

export interface AnalyticsOverview {
  funnel: FunnelStage[];
  rates: AnalyticsRates;
  topAdded: ProductStat[];
  topAbandoned: AbandonedProduct[];
}

/**
 * Everything the admin data tab needs for one window.
 *
 * Three independent queries, so they go out together: the funnel totals and the two product
 * rankings share nothing, and against a database in another region the difference between three
 * round trips and one is the tab's render time.
 */
export async function getAnalyticsOverview(fromISO: string, toISO: string): Promise<AnalyticsOverview> {
  const [totals, topAdded, topAbandoned] = await Promise.all([
    getEventTotals(fromISO, toISO),
    getTopProductsByEvent('add_to_cart', fromISO, toISO),
    getTopAbandonedProducts(fromISO, toISO),
  ]);
  return {
    funnel: buildFunnel(totals),
    rates: buildAnalyticsRates(totals),
    topAdded,
    topAbandoned,
  };
}

/**
 * Distinct sessions that fired `type` across ALL recorded days — for lifetime figures like the
 * seller-onboarding funnel's "visited the register page" top, which is cumulative by design
 * (seller-funnel.ts says why) and therefore takes no range at all.
 */
export async function getLifetimeEventSessions(type: AnalyticsEvent): Promise<number> {
  const result = await rows<{ sessions: number | string }>(
    `SELECT COUNT(DISTINCT visitor_id) AS sessions FROM analytics_visitors WHERE event = $1`,
    [type],
  );
  return count(result[0]?.sessions ?? 0);
}

/**
 * Drop session rows older than the retention window — see `VISITOR_RETENTION_DAYS` for the window
 * itself and why it is that number.
 *
 * **`AUX_EVENTS` are excluded, and that exclusion is the whole correctness argument.** Every other
 * reader of this table is date-bounded (`getEventTotals`), so deleting outside the window cannot
 * change a number anyone can ask for. `getLifetimeEventSessions` is the exception: it counts
 * `COUNT(DISTINCT visitor_id)` with **no** date bound, deliberately — the seller-onboarding funnel's
 * top is cumulative since launch (`seller-funnel.ts` says why) — so a purge that touched its rows
 * would silently walk a displayed number downwards.
 *
 * The obvious repair is a rolled-up counter: snapshot the pre-cutoff distinct count, delete, then
 * add the two. It is **wrong**, and quietly: distinct counts do not add. A visitor who appears on
 * both sides of the cutoff is one session and would be counted twice, so the "lifetime" figure
 * would drift upward a little more at every purge, in the direction that looks like growth.
 *
 * Excluding the events instead is exact rather than approximate, and it costs nothing here because
 * of what those events are: `AUX_EVENTS` is one visit to the seller registration page, against
 * `page_view` on every page load by every shopper. The rows this keeps forever are a rounding error
 * beside the rows it deletes, which is precisely why the cheap answer is also the right one. If an
 * aux event ever became high-volume, the honest fix is a dedicated counter written at the time of
 * the event — not a sum of distinct counts.
 */
export async function purgeOldAnalyticsVisitors(cutoffDayISO: string): Promise<number> {
  if (!isDayISO(cutoffDayISO)) throw new Error(`purgeOldAnalyticsVisitors: bad day ${cutoffDayISO}`);
  const { rowCount } = await query(
    `DELETE FROM analytics_visitors
      WHERE day < $1::date AND event <> ALL($2::text[])`,
    [cutoffDayISO, AUX_EVENTS],
  );
  return rowCount;
}
