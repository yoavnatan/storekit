import { isUuid, query, rows } from './db.js';
import { businessDayISO, isDayISO } from './business-day.js';
import type { ViewGranularity } from './store-pageviews.js';

/**
 * Per-product view counters — the product-level twin of `store-pageviews.ts`, moved to Postgres in
 * the same diff (DB_MIGRATION_PLAN.md §5, §8) because one function reads both.
 *
 * A "view" is counted from two surfaces (CURRENT_TASK.md, סשן א׳): a full product-page load
 * (tapped in `middleware.ts`) and a quick-view/product-modal open (tapped in `/api/store-product`,
 * the modal's data source) — a lot of product viewing happens in the modal without the page ever
 * loading, so counting only page loads would understate real interest.
 *
 * **Totals only, no visitor set — a deliberate difference from the store-level metric.** "How many
 * times was this product looked at" is the question the drill-down asks; a per-product unique count
 * would multiply stored rows by every distinct browser per product per day for marginal extra
 * signal, and uniqueness is already answered one level up. `product_page_view_visitors` exists in
 * the schema and carries what the import found, but nothing here writes it.
 *
 * Keyed by the product's id, which is immutable — a rename changes the slug and history survives.
 * `day` is decided by the application on the business calendar, never by the database (§7.8); see
 * `store-pageviews.ts` for why that is not a detail.
 */

export interface ProductViewBucket {
  /** 'YYYY-MM-DD' or 'YYYY-MM', matching the store summary's x-axis keys. */
  key: string;
  views: number;
}

export interface ProductViewStats {
  buckets: ProductViewBucket[];
  totalViews: number;
}

export const EMPTY_PRODUCT_VIEW_STATS: ProductViewStats = { buckets: [], totalViews: 0 };

/**
 * Record one view of a product. Fire-and-forget: never throws, never rejects (callers use `void`).
 *
 * One `INSERT … ON CONFLICT DO UPDATE`, with no SELECT in front of it — this runs on every product
 * page load and every modal open, so a read-then-write here would cost two round trips and a race.
 */
export async function recordProductView(productId: string): Promise<void> {
  if (!isUuid(productId)) return;
  try {
    await query(
      `INSERT INTO product_page_views (product_id, day, total)
       VALUES ($1::uuid, $2::date, 1)
       ON CONFLICT (product_id, day) DO UPDATE SET total = product_page_views.total + 1`,
      [productId, businessDayISO(new Date())],
    );
  } catch { /* analytics must never break a request */ }
}

interface BucketRow { bucket: string; views: number | string }

/**
 * Views for one product over [fromISO, toISO] inclusive, bucketed by `granularity`.
 *
 * Bucketing happens in the `GROUP BY` rather than over per-day rows in JS for consistency with the
 * store-level twin — the two series are plotted on one axis, and one of them deciding its own
 * bucket boundaries is how they would drift apart.
 */
export async function getProductViewStats(
  productId: string,
  fromISO: string,
  toISO: string,
  granularity: ViewGranularity,
): Promise<ProductViewStats> {
  // Shape before query, for both kinds of identifier — see the twin in store-pageviews.ts.
  if (!isUuid(productId) || !isDayISO(fromISO) || !isDayISO(toISO)) return EMPTY_PRODUCT_VIEW_STATS;
  const format = granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const bucketRows = await rows<BucketRow>(
    `SELECT to_char(day, $4::text) AS bucket, SUM(total) AS views
       FROM product_page_views
      WHERE product_id = $1::uuid AND day >= $2::date AND day <= $3::date
      GROUP BY to_char(day, $4::text)
      ORDER BY 1`,
    [productId, fromISO, toISO, format],
  );

  const stats: ProductViewStats = { buckets: [], totalViews: 0 };
  for (const row of bucketRows) {
    // `SUM` of an integer column is `bigint` — a string from `pg`, a number from PGlite (§8).
    const views = Number(row.views ?? 0);
    stats.buckets.push({ key: row.bucket, views });
    stats.totalViews += views;
  }
  return stats;
}
