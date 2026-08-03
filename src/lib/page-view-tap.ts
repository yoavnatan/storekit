import { query } from './db.js';
import { businessDayISO } from './business-day.js';
import type { AnalyticsEvent } from './analytics.js';

/**
 * Everything one page view writes, as ONE statement.
 *
 * **Why this module exists.** Loading a product page used to issue four separate writes — the funnel
 * `page_view`, the funnel `view_item`, the store's page-view counter and the product's — from three
 * modules that had each (correctly) collapsed their own tables into a single round trip and had no
 * way to see the other three. Against a managed Postgres in another region that is four round trips
 * on the hottest path in the application, measured as four of the five a page load spends
 * (`DB_MIGRATION_PLAN.md` §8, "the practical conclusion"): every one of them holds a pooled
 * connection for a full network turn to insert a handful of integers.
 *
 * They are all the same event — *a person looked at a page* — so they are now one statement and one
 * round trip, no matter how many of the six tables it touches. A data-modifying `WITH` clause always
 * executes whether or not the outer query reads from it, which is what carries all six without a
 * transaction's extra BEGIN/COMMIT.
 *
 * **This module owns the write SQL for those tables; the modules named after them own the reads.**
 * That split is deliberate and it is the only way the round trip can be one: `recordAnalyticsEvent`,
 * `recordPageView` and `recordProductView` still exist with their old signatures and their old call
 * sites, but they are now single-intent calls into this. A second copy of any of these INSERTs is
 * the bug this shape exists to prevent — there is exactly one place where a page view is written.
 *
 * NEVER throws and never rejects: this runs on every page load and an analytics tap that can fail a
 * render is worse than one that loses a count. Callers use `void`.
 */
export interface PageViewTap {
  /**
   * Funnel events this page view produced — `page_view` plus at most one narrower stage.
   * **Deduplicated before it is sent:** Postgres rejects an `ON CONFLICT DO UPDATE` that would
   * touch the same row twice within one command, and two identical events in one call would.
   */
  events?: readonly AnalyticsEvent[];
  /** The session id, for the once-per-session funnel counts. Empty string = no session resolved. */
  visitorId?: string;
  /** Store whose page was viewed — counts one store page view (and one unique, with `visitorId`). */
  storeId?: string;
  /** Product whose page was viewed — counts one product page view. */
  productId?: string;
  /** The event `productIds` belong to. Ignored (and the ids dropped) when absent. */
  productEvent?: AnalyticsEvent;
  /** Products named by `productEvent`. May legitimately repeat — see the GROUP BY below. */
  productIds?: readonly string[];
}

// A product id is whatever the recorded event carried, capped to the column's working width. The
// column is `text` with no foreign key ON PURPOSE (see its note in 0001_init.sql): a tally of a
// product that has since been deleted is still history. The IDENTITY rule — new events may only
// name a real uuid — belongs at the untrusted boundary (`/api/analytics/event`), not here, where
// legacy ids from the imported past must keep resolving. `productId` below is the exception: it
// writes a `uuid` COLUMN, so a non-uuid there is dropped rather than raised.
const MAX_PRODUCT_ID_LEN = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `null` rather than `''` for an absent id: `''::uuid` is a cast error, `NULL::uuid` is not. */
const asUuid = (id: string | undefined): string | null => (id && UUID_RE.test(id) ? id : null);

export async function recordPageViewTap(tap: PageViewTap): Promise<void> {
  try {
    const events = [...new Set(tap.events ?? [])];
    const productEvent = tap.productEvent ?? '';
    const productIds = productEvent
      ? (tap.productIds ?? [])
          .filter((id): id is string => typeof id === 'string' && id !== '')
          .map((id) => id.slice(0, MAX_PRODUCT_ID_LEN))
      : [];
    const storeId = asUuid(tap.storeId);
    const productId = asUuid(tap.productId);
    if (events.length === 0 && productIds.length === 0 && !storeId && !productId) return;

    await query(
      `WITH ev AS (
         INSERT INTO analytics_daily (day, event, count)
         SELECT $1::date, e, 1 FROM unnest($2::text[]) AS e
         ON CONFLICT (day, event) DO UPDATE SET count = analytics_daily.count + EXCLUDED.count
       ), seen AS (
         INSERT INTO analytics_visitors (day, event, visitor_id)
         SELECT $1::date, e, $3 FROM unnest($2::text[]) AS e WHERE $3 <> ''
         ON CONFLICT DO NOTHING
       ), prod AS (
         -- Grouped before insert, and that is not a micro-optimisation: one call can legitimately
         -- name the same product twice (a checkout with two variants of it), and Postgres rejects
         -- an ON CONFLICT DO UPDATE that would touch the same row twice in one command.
         INSERT INTO analytics_products (day, event, product_id, count)
         SELECT $1::date, $4, pid, COUNT(*) FROM unnest($5::text[]) AS pid GROUP BY pid
         ON CONFLICT (day, event, product_id)
         DO UPDATE SET count = analytics_products.count + EXCLUDED.count
       ), store_total AS (
         INSERT INTO store_page_views (store_id, day, total)
         SELECT $6::uuid, $1::date, 1 WHERE $6::uuid IS NOT NULL
         ON CONFLICT (store_id, day) DO UPDATE SET total = store_page_views.total + 1
       ), store_seen AS (
         INSERT INTO store_page_view_visitors (store_id, day, visitor_id)
         SELECT $6::uuid, $1::date, $3 WHERE $6::uuid IS NOT NULL AND $3 <> ''
         ON CONFLICT DO NOTHING
       )
       INSERT INTO product_page_views (product_id, day, total)
       SELECT $7::uuid, $1::date, 1 WHERE $7::uuid IS NOT NULL
       ON CONFLICT (product_id, day) DO UPDATE SET total = product_page_views.total + 1`,
      [businessDayISO(new Date()), events, tap.visitorId ?? '', productEvent, productIds, storeId, productId],
    );
  } catch { /* analytics must never break a request */ }
}
