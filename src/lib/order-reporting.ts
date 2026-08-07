/**
 * Every whole-platform question about orders, answered by the database (DB_MIGRATION_PLAN.md §3).
 *
 * **What this module replaced.** Five admin surfaces used to call `getAllOrders()` and do the work
 * in JavaScript: the Overview headline summed every order, the Stores tab grouped them by slug, the
 * Orders tab filtered/sorted/paged an array of all of them to show fifteen rows, the Performance
 * tab ran a per-store bucketing pass ONCE PER STORE over the same array, and reconcile.ts walked
 * them twice more. At 207 orders none of that is slow; at 100,000 every one of them is the same
 * bug, and the aggregation is work Postgres does in one round trip.
 *
 * **The two shapes, and which is which.** Anything that is arithmetic over data the caller already
 * holds stayed pure and stayed in `admin-stats.ts`/`platform-performance.ts` — it takes its data as
 * a parameter, stays synchronous, and is testable without a database. Anything that was a
 * `GROUP BY` written as a `for` loop is a query, and lives here. That split is the whole rule; the
 * page-view move (§5) and the `analytics` move made the same one.
 *
 * **The revenue rule is never spelled out in SQL.** `order-status-rules.ts` is the single table
 * that says which statuses count, and every statement below takes its two columns as list
 * parameters — the same discipline `getPurchasedCountsByStoreSlugs` already follows. A literal
 * `payment_status = 'paid'` here would be a second copy of the rule in a language no test can see.
 *
 * **Net, not subtotal.** Every revenue figure is `subtotal − discount applied`, floored at zero —
 * the SQL half of `admin-stats.ts#orderNetForStore`, and the reason the floor is here too is that
 * a row written before the discount ceiling existed must report as zero rather than as negative
 * money. `reconcile.ts` is what says the row itself is wrong; a report must not bend it silently.
 */
import { rows, firstRow } from './db.js';
import { CHECKOUT_GROUP_KEY_SQL } from './checkout-group.js';
import { BUSINESS_TIMEZONE } from './business-day.js';
import type { PerformanceGranularity } from './seller-performance.js';
import type { TopProduct } from './seller-performance.js';
import {
  REVENUE_PAYMENT_STATUSES,
  REVENUE_SHIPPING_STATUSES,
  CLOSURE_BLOCKING_PAYMENT_STATUSES,
  CLOSURE_BLOCKING_SHIPPING_STATUSES,
} from './order-status-rules.js';

/** `bigint` is a string from `pg` and a number from PGlite; `COUNT` and every `SUM` below is one.
 *  Untouched, `'1250' + 500` is `'1250500'` — a wrong number four orders of magnitude out, with no
 *  error anywhere (DB_MIGRATION_PLAN.md §8, the `orders` diff). */
const num = (v: string | number | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** The revenue predicate as SQL, over an `orders o` already in scope. */
const COUNTS_AS_REVENUE = 'o.payment_status = ANY($1::text[]) AND o.shipping_status = ANY($2::text[])';
const REVENUE_PARAMS = [REVENUE_PAYMENT_STATUSES, REVENUE_SHIPPING_STATUSES] as const;

/** One store's slice of one order, net of the seller's own discount and never below zero.
 *  The SQL twin of `admin-stats.ts#orderNetForStore`. */
const NET = 'GREATEST(os.subtotal_agorot - os.discount_applied_agorot, 0)';

/** The business day/month an order landed on, in SQL. The platform has ONE calendar
 *  (business-day.ts) and it is not the server's: UTC files every sale between local midnight and
 *  02:00/03:00 under the previous day, which is the bug that module exists to close. Same
 *  conversion `money-events.ts` already uses for the journal's date window. */
const businessBucket = (granularity: PerformanceGranularity, column = 'o.created_at'): string =>
  granularity === 'day'
    ? `to_char(${column} AT TIME ZONE $3::text, 'YYYY-MM-DD')`
    : `to_char(${column} AT TIME ZONE $3::text, 'YYYY-MM')`;

// ── Overview headline ────────────────────────────────────────────────────────

/** The three order figures on the admin Overview card. Seller/store counts are not here: they are
 *  questions about the roster, and `stores.ts`/`seller-auth.ts` own those. */
export interface PlatformOrderTotals {
  /** EVERY order row, whatever its payment state. */
  totalOrders: number;
  /** Orders that counted as money — the population `gmvAgorot` is summed over. */
  paidOrders: number;
  /** Gross merchandise value: net of seller discounts, excluding shipping. Same basis as
   *  `getStoreRevenueBySlug`, so the headline equals the sum of the per-store rows exactly
   *  (asserted in tests/reporting-invariants.test.ts). */
  gmvAgorot: number;
}

export async function getPlatformOrderTotals(): Promise<PlatformOrderTotals> {
  const row = await firstRow<{ total_orders: string | number; paid_orders: string | number; gmv: string | number | null }>(
    `SELECT COUNT(*)                                                   AS total_orders,
            COUNT(*) FILTER (WHERE ${COUNTS_AS_REVENUE})               AS paid_orders,
            COALESCE(SUM(net.amount) FILTER (WHERE ${COUNTS_AS_REVENUE}), 0) AS gmv
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(${NET}), 0) AS amount
           FROM order_stores os WHERE os.order_id = o.id
       ) net ON true`,
    [...REVENUE_PARAMS],
  );
  return {
    totalOrders: num(row?.total_orders),
    paidOrders: num(row?.paid_orders),
    gmvAgorot: num(row?.gmv),
  };
}

// ── Revenue per store ────────────────────────────────────────────────────────

/** Both integer agorot — these are SUMS, the side of the boundary the unit flip was for.
 *  A caller that shows one renders it with `money.ts#formatAgorot`. */
export interface StoreRevenue {
  totalRevenueAgorot: number; // all-time, revenue-counting orders only, net of seller discount
  monthRevenueAgorot: number; // the current business month, same basis
}

export const EMPTY_STORE_REVENUE: StoreRevenue = { totalRevenueAgorot: 0, monthRevenueAgorot: 0 };

/**
 * storeSlug → revenue, over every order on the platform. One `GROUP BY` where a `for` loop over
 * every order used to be.
 *
 * `monthKey` ('YYYY-MM') is passed in rather than derived here so the caller's "this month" and
 * this query's are the same string — the admin dashboard reads it from `businessMonthKey`, and a
 * month computed twice from two clocks is how the Overview and the Stores tab came to disagree
 * about which sales were recent.
 */
export async function getStoreRevenueBySlug(monthKey: string): Promise<Map<string, StoreRevenue>> {
  const found = await rows<{ store_slug: string; total: string | number; month: string | number }>(
    `SELECT os.store_slug,
            SUM(${NET})                                                       AS total,
            SUM(${NET}) FILTER (WHERE ${businessBucket('month')} = $4::text)  AS month
       FROM order_stores os
       JOIN orders o ON o.id = os.order_id
      WHERE ${COUNTS_AS_REVENUE}
      GROUP BY os.store_slug`,
    [...REVENUE_PARAMS, BUSINESS_TIMEZONE, monthKey],
  );
  return new Map(found.map((r) => [r.store_slug, {
    totalRevenueAgorot: num(r.total),
    monthRevenueAgorot: num(r.month),
  }]));
}

// ── Open orders per store ────────────────────────────────────────────────────

/**
 * storeSlug → orders that still owe the buyer something (the count a closing store waits on).
 *
 * The pure twin, `store-lifecycle.ts#countOpenOrdersByStore`, stays for a caller that already
 * holds the orders; this is the one the admin dashboard uses, and both read the same two columns
 * of `order-status-rules.ts` so the admin's "3 open" cannot disagree with the seller's own screen.
 * An order naming a store twice is still one obligation — hence `DISTINCT`.
 */
export async function getOpenOrderCountsByStore(): Promise<Map<string, number>> {
  const found = await rows<{ store_slug: string; open: string | number }>(
    `SELECT it.store_slug, COUNT(DISTINCT it.order_id) AS open
       FROM order_items it
       JOIN orders o ON o.id = it.order_id
      WHERE o.payment_status = ANY($1::text[]) AND o.shipping_status = ANY($2::text[])
      GROUP BY it.store_slug`,
    [CLOSURE_BLOCKING_PAYMENT_STATUSES, CLOSURE_BLOCKING_SHIPPING_STATUSES],
  );
  return new Map(found.map((r) => [r.store_slug, num(r.open)]));
}

// ── "new since you last opened the tab" ──────────────────────────────────────

/** How many orders arrived after `boundaryISO` — the Orders tab's "(N)" badge. It is counted over
 *  the UNFILTERED set on purpose (a search box left open must not change it), which is exactly why
 *  it cannot be `page.total`. */
export async function countOrdersSince(boundaryISO: string): Promise<number> {
  // DISTINCT on the checkout-group key, because the tab this badge sits on lists PURCHASES: a
  // five-store cart is one card there, and a badge counting rows would announce "5 new" above a
  // list showing one. The badge, the "חדש" chip on the card and the "חדשות בלבד" filter have to
  // tell one story — that is the whole reason the boundary is read once and threaded through.
  const row = await firstRow<{ n: string | number }>(
    `SELECT COUNT(DISTINCT ${CHECKOUT_GROUP_KEY_SQL}) AS n FROM orders o WHERE o.created_at > $1::timestamptz`,
    [boundaryISO],
  );
  return num(row?.n);
}

/** Every store NAME that appears on any order line — the Orders tab's store filter dropdown.
 *  Bounded by how many stores have ever sold, not by how many orders exist. Sorted by the caller,
 *  which sorts Hebrew with `localeCompare('he')`. */
export async function getAllOrderStoreNames(): Promise<string[]> {
  const found = await rows<{ store_name: string }>(
    `SELECT DISTINCT store_name FROM order_items WHERE store_name <> ''`,
  );
  return found.map((r) => r.store_name);
}

// ── Platform performance: sales, bucketed, for every store at once ───────────

/** One bucket of one store's sales, at the granularity the caller asked for. */
export interface SalesBucket {
  key: string; // 'YYYY-MM-DD' or 'YYYY-MM' — the same axis key seller-performance.ts lays out
  revenueAgorot: number;
  orders: number;
}

export interface StoreSales {
  buckets: SalesBucket[];
  totalRevenueAgorot: number;
  totalOrders: number;
}

export const EMPTY_STORE_SALES: StoreSales = { buckets: [], totalRevenueAgorot: 0, totalOrders: 0 };

export interface PlatformSales {
  /** storeSlug → that store's sales in range. Every requested slug gets an entry. */
  byStore: Map<string, StoreSales>;
  /** The platform's leading products by revenue, ranked and capped IN THE QUERY. Not a merge of
   *  per-store top-Ns — that would be a top-N of each store's top-N, which is a different list. */
  topProducts: TopProduct[];
}

/**
 * Every store's sales over [fromISO, toISO], bucketed, in two queries.
 *
 * **This is the change that made the admin Performance tab stop being O(stores × orders).** It ran
 * `buildPerformanceSummary` once per store over the SAME array of every order on the platform:
 * 45 stores × 207 orders today, 1,000 × 100,000 the moment the platform works. Sales are now an
 * INPUT to that aggregation exactly as page views already are (§5, `getStoreViewStats`) — the
 * caller fetches them once for every store, and `platform-performance.ts` stays pure arithmetic
 * over what it was handed.
 *
 * `topLimit <= 0` returns every product that sold in range — what the revenue-breakdown modal
 * asks for when it wants the full composition rather than a leaderboard.
 */
export async function getPlatformSales(
  storeSlugs: readonly string[],
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
  topLimit = 5,
): Promise<PlatformSales> {
  const slugs = [...new Set(storeSlugs.filter(Boolean))];
  const byStore = new Map<string, StoreSales>(slugs.map((s) => [s, { buckets: [], totalRevenueAgorot: 0, totalOrders: 0 }]));
  if (!slugs.length) return { byStore, topProducts: [] };

  // Membership is decided on the BUSINESS day the order landed on, compared against the range's
  // own business-day bounds — the same rule `buildPerformanceSummary` applies in JS. The two views
  // sit on one axis and are read against each other, so they cannot use two calendars.
  const IN_RANGE = `(o.created_at AT TIME ZONE $3::text)::date BETWEEN $5::date AND $6::date`;
  const scope = [...REVENUE_PARAMS, BUSINESS_TIMEZONE, slugs, fromISO, toISO] as const;

  const [bucketRows, productRows] = await Promise.all([
    rows<{ store_slug: string; bucket: string; revenue: string | number; orders: string | number }>(
      `SELECT os.store_slug,
              ${businessBucket(granularity)} AS bucket,
              SUM(${NET})                    AS revenue,
              COUNT(*)                       AS orders
         FROM order_stores os
         JOIN orders o ON o.id = os.order_id
        WHERE os.store_slug = ANY($4::text[]) AND ${COUNTS_AS_REVENUE} AND ${IN_RANGE}
        GROUP BY os.store_slug, bucket`,
      [...scope],
    ),
    rows<{ product_id: string | null; name: string; revenue: string | number; units: string | number }>(
      // Gross, pre order-level discount — the discount is stored per store-subtotal and never per
      // line, so apportioning it across products would be an invention. Same basis as
      // `TopProduct.revenueAgorot` has always carried.
      //
      // The join to `order_stores` is the SQL half of the JS filter it replaces: a line only counts
      // when its order actually carries a subtotal row for that store.
      //
      // The NAME is the one from the most recent order that sold it — same answer the JS map gave,
      // which kept whichever name it met first while walking newest-first.
      `SELECT it.product_id,
              (array_agg(it.product_name ORDER BY o.created_at DESC, o.id))[1] AS name,
              SUM(it.price_agorot * it.qty) AS revenue,
              SUM(it.qty)                   AS units
         FROM order_items it
         JOIN orders o       ON o.id = it.order_id
         JOIN order_stores os ON os.order_id = o.id AND os.store_slug = it.store_slug
        WHERE it.store_slug = ANY($4::text[]) AND ${COUNTS_AS_REVENUE} AND ${IN_RANGE}
        GROUP BY it.product_id
        ORDER BY revenue DESC
        ${topLimit > 0 ? 'LIMIT $7' : ''}`,
      topLimit > 0 ? [...scope, topLimit] : [...scope],
    ),
  ]);

  for (const row of bucketRows) {
    const store = byStore.get(row.store_slug);
    if (!store) continue;
    const revenueAgorot = num(row.revenue);
    const orders = num(row.orders);
    store.buckets.push({ key: row.bucket, revenueAgorot, orders });
    store.totalRevenueAgorot += revenueAgorot;
    store.totalOrders += orders;
  }

  return {
    byStore,
    topProducts: productRows.map((r) => ({
      // A line whose product was deleted keeps '' as its id, exactly as `orders.ts#toItem` reads it.
      productId: r.product_id ?? '',
      name: r.name,
      revenueAgorot: num(r.revenue),
      units: num(r.units),
    })),
  };
}
