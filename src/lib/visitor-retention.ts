import { addDaysISO } from './date-range.js';
import { businessDayISO } from './business-day.js';

/**
 * How far back per-visitor detail is kept — one number, because two copies of a retention window
 * are two different answers to "why is this figure zero".
 *
 * **What actually grows, and what does not.** Page-view data is stored at two levels, and only one
 * of them scales with traffic:
 *
 *   `store_page_views`          one row per (store, day)            — ~365 rows per store per year
 *   `store_page_view_visitors`  one row per (store, day, VISITOR)   — one per person per day
 *   `analytics_daily`           one row per (day, event)            — a handful per day, platform-wide
 *   `analytics_visitors`        one row per (day, event, VISITOR)   — one per person per event per day
 *
 * The aggregate tables are tiny and are kept **forever**: view counts, funnel volumes and every
 * revenue-adjacent number derived from them stay complete for the life of the platform. Only the
 * two per-visitor tables are bounded, and they exist for exactly one question — "how many *distinct*
 * people", which cannot be answered from a total because a returning visitor must count once.
 *
 * So the cost of this window is precise and small: a range older than it reports views correctly and
 * unique visitors as zero. Nothing else moves.
 *
 * **Why 400 and not 90 or 365.** The dashboards decide this, not a guess. The longest preset any
 * surface offers is 90 days (`scripts/dashboard/performance.ts`: today / thisWeek / thisMonth /
 * lastMonth / 7d / 30d / 90d), and both the seller and admin panels also accept a free custom range.
 * 400 clears the longest preset four times over and — the reason it is not 365 — keeps a full
 * *year-ago comparison* inside the window: a range that ends today and starts twelve months back
 * needs more than 365 days of history to be complete at both ends, and the extra five weeks absorb
 * that without a second thought. Above all it converts the table from unbounded to a ceiling: at
 * steady traffic it stops growing instead of growing forever, which is the entire point.
 *
 * Owner decision, 2026-08-09. Changing it is changing what a seller can see — GO_LIVE §6.
 */
export const VISITOR_RETENTION_DAYS = 400;

/**
 * The oldest day that is KEPT. Rows strictly before it are dropped.
 *
 * Derived from the **business** calendar and never from the database (`analytics.ts` header,
 * DB_MIGRATION_PLAN §7.8): the server runs in UTC and the platform's day is Asia/Jerusalem, so a
 * `CURRENT_DATE` in the SQL would cut on a different calendar than the one the rows were written on
 * — off by one for a few hours every night, in a statement whose mistakes are not recoverable.
 *
 * `today` is injectable so a test can place the cutoff instead of waiting 400 days for one.
 */
export function visitorRetentionCutoffISO(today: Date = new Date()): string {
  return addDaysISO(businessDayISO(today), -VISITOR_RETENTION_DAYS);
}
