import { firstRow } from './db.js';
import { NET_SQL } from './order-reporting.js';
import { REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES } from './order-status-rules.js';
import { SELLER_TIERS, DEFAULT_TIER } from './pricing.js';
import { BUSINESS_TIMEZONE } from './business-day.js';

/**
 * **What the platform earned in a window — the one read the accounting statement is built from.**
 *
 * It lived in `payouts.ts` until 2026-08-21, beside the tables that recorded transfers to sellers.
 * Those are gone with the custodial model and this is not: it asks nothing about money moving, only
 * about sales that happened and the commission they carried, so it survives the change intact and
 * now has a module whose name is true. `platform-statement.ts` is its only consumer.
 *
 * Nothing here reads `seller_payouts` or `seller_ledger_adjustments`. If a figure on the statement
 * ever needs one of those again, the model changed and this module is not the place to hide it.
 */

/**
 * A period, as the accounting statement means it: both ends optional and INCLUSIVE, on the business
 * calendar. `from: null` means "since the beginning".
 */
export interface LedgerWindow {
  from: string | null;
  to: string | null;
}

/** `col` bounded by `w`, as SQL + the parameters it consumes. An absent bound produces no clause at
 *  all rather than a sentinel date, so an open-ended question stays an index scan over the column
 *  instead of a comparison against year 0001. */
function windowClause(col: string, w: LedgerWindow, params: unknown[]): string {
  const parts: string[] = [];
  const day = `(${col} AT TIME ZONE '${BUSINESS_TIMEZONE}')::date`;
  if (w.from) { params.push(w.from); parts.push(`${day} >= $${params.length}::date`); }
  if (w.to) { params.push(w.to); parts.push(`${day} <= $${params.length}::date`); }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/** `bigint` arrives from `pg` as a string and from PGlite as a number — the same conversion
 *  `orders.ts` and `store-coupons.ts` do, for the same columns and the same reason. */
function big(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** What the platform accrued in one window — the accounting statement's whole basis. */
export interface LedgerAccrual {
  grossAgorot: number;
  commissionAgorot: number;
  /** gross − commission: the sellers' own share of those sales. Context for the gross figure, and
   *  never a liability of ours — it lands in each seller's own account at the processor. */
  netAgorot: number;
  /** Distinct purchases, not per-store slices — the count a person would say out loud. */
  purchases: number;
}

/**
 * Sales accrued in a window, for every seller at once.
 *
 * **Bucketed by `orders.created_at`, and that is a decision rather than a default.** Every other
 * report on this platform buckets by that column (`order-reporting.ts#businessBucket`), so a
 * statement using `paid_at` would put a handful of orders in a different month from the Performance
 * tab and no one could tell which was wrong.
 *
 * The revenue predicate and the per-slice commission rounding are the shared ones
 * (`order-status-rules.ts`, `pricing.ts`), so a period's figures are the same arithmetic every
 * other money surface uses, restricted to a window.
 */
export async function getLedgerAccrual(w: LedgerWindow): Promise<LedgerAccrual> {
  const params: unknown[] = [REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES];
  const where = `o.payment_status = ANY($1::text[]) AND o.shipping_status = ANY($2::text[])${windowClause('o.created_at', w, params)}`;
  params.push(SELLER_TIERS.map((t) => t.id), SELLER_TIERS.map((t) => t.commissionPercent), DEFAULT_TIER);
  const A = params.length - 2, B = params.length - 1, C = params.length;
  const found = await firstRow<{ gross: string | number; commission: string | number; purchases: string | number }>(
    `SELECT COALESCE(SUM(${NET_SQL}), 0)                                   AS gross,
            COALESCE(SUM(ROUND(${NET_SQL} * r.pct / 100.0)), 0)            AS commission,
            COUNT(DISTINCT o.id)                                           AS purchases
       FROM order_stores os
       JOIN orders  o   ON o.id = os.order_id
       JOIN stores  st  ON st.slug = os.store_slug
       JOIN sellers sel ON sel.id = st.seller_id
       JOIN unnest($${A}::text[], $${B}::numeric[]) AS r(tier, pct)
              ON r.tier = COALESCE(sel.tier, $${C}::text)
      WHERE ${where}`,
    params,
  );
  const grossAgorot = big(found?.gross);
  const commissionAgorot = big(found?.commission);
  return { grossAgorot, commissionAgorot, netAgorot: grossAgorot - commissionAgorot, purchases: big(found?.purchases) };
}
