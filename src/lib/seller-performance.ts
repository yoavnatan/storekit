import type { Order } from './orders.js';
import { countsAsRevenue } from './orders.js';
import { orderNetForStore } from './admin-stats.js';
import type { StoreViewStats, ViewGranularity } from './store-pageviews.js';
import type { ProductViewStats } from './product-pageviews.js';
import { businessDayISO, businessMonthKey, calendarDayISO, calendarMonthKey, dayInRange, BUSINESS_TIMEZONE } from './business-day.js';
import { commissionOnAgorot } from './pricing.js';

/**
 * One definition, aliased rather than repeated: the bucket size a report is drawn at is the same
 * fact the page-view query groups by, and two copies of a two-member union are two things that can
 * disagree about what a caller asked for.
 */
export type PerformanceGranularity = ViewGranularity;

export interface PerformancePoint {
  key: string;   // 'YYYY-MM-DD' (day) or 'YYYY-MM' (month) — stable sort/chart key
  label: string; // pre-formatted for display (Hebrew-aware), so client charts never reformat dates themselves
  revenueAgorot: number;
  orders: number;
  views: number;          // total loads in this bucket (repeat visits counted)
  uniqueVisitors: number; // distinct visitor ids in this bucket (unioned, not summed, across its days)
}

export interface TopProduct {
  productId: string;
  name: string;
  revenueAgorot: number; // gross (pre order-level discount — discount is only stored per store-subtotal, not per item)
  units: number;
}

export interface PerformanceSummary {
  granularity: PerformanceGranularity;
  points: PerformancePoint[];
  totalRevenueAgorot: number;
  totalOrders: number;
  avgOrderValueAgorot: number;
  totalViews: number;          // total loads across the range (repeat visits counted)
  totalUniqueVisitors: number; // distinct visitors across the whole range (a returning visitor counts once)
  conversionRate: number; // orders / unique-visitors * 100 (falls back to total views when no visitor ids exist, e.g. legacy/demo data), 0 when neither
  topProducts: TopProduct[];
  // Profitability (reporting only — the real deduction happens at the
  // split-payment processor). commissionRate is echoed back so the client can
  // label the expense line ("platform commission (10%)") without re-reading
  // store.config; platformCommissionAgorot/netProfitAgorot are pre-computed server-side so
  // SSR and the AJAX re-render can never drift on the rounding.
  commissionRate: number;      // percent, e.g. 10
  platformCommissionAgorot: number;  // totalRevenueAgorot * commissionRate / 100, the seller's expense
  netProfitAgorot: number;           // totalRevenueAgorot - platformCommissionAgorot, what the seller actually receives
}

export interface ProductPerformancePoint {
  key: string;   // 'YYYY-MM-DD' (day) or 'YYYY-MM' (month)
  label: string; // pre-formatted, Hebrew-aware
  units: number;
  revenueAgorot: number; // gross (pre order-level discount, same basis as TopProduct.revenueAgorot)
  views: number;   // product-page loads in this bucket
}

export interface ProductPerformanceSummary {
  productId: string;
  granularity: PerformanceGranularity;
  points: ProductPerformancePoint[];
  totalUnits: number;
  totalRevenueAgorot: number;
  totalViews: number;
  ordersWithProduct: number; // distinct paid orders in range that contained this product
  conversionRate: number;    // ordersWithProduct / totalViews * 100, 0 when no views
}

/** Which bucket an ORDER falls in — the business calendar (business-day.ts), never
 *  the runtime's. This used to be `toISOString().slice(0,10)`, i.e. UTC, while the
 *  range it was compared against was built from the local calendar: every sale
 *  between local midnight and 02:00/03:00 was filed under the previous day, and one
 *  placed just after midnight on the 1st dropped out of "this month" altogether. */
const bucketKeyOf = (d: Date, granularity: PerformanceGranularity): string =>
  granularity === 'day' ? businessDayISO(d) : businessMonthKey(d);

/** The zero-filled x-axis keys for a range at a given granularity — shared by the store and per-product builders so their bars line up on the same axis.
 *  The cursor here is a synthetic calendar date, not a moment in time, so it is read
 *  back with the calendar* helpers (see business-day.ts's header for why the two
 *  families exist). */
function rangeKeys(fromISO: string, toISO: string, granularity: PerformanceGranularity): string[] {
  const from = new Date(fromISO + 'T00:00:00.000Z');
  const to = new Date(toISO + 'T23:59:59.999Z');
  const keys: string[] = [];
  if (granularity === 'day') {
    const cur = new Date(from);
    while (cur <= to) { keys.push(calendarDayISO(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  } else {
    const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    while (cur <= end) { keys.push(calendarMonthKey(cur)); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  }
  return keys;
}

// Axis labels render a pure calendar date, so they are formatted in a fixed zone
// rather than the runtime's — otherwise the same bucket key reads as a different
// day on a server west of UTC than it does in the browser that requested it.
//
// The formatters are built ONCE, and the label for a given key is memoised.
// `toLocaleDateString(locale, opts)` looks like a method call but constructs a
// whole Intl.DateTimeFormat every time (~0.2ms). One axis is only ~31 labels, but
// the platform performance tab builds the same axis once per store: 45 × 31 calls
// = ~250ms of a ~280ms aggregation, and the platform aggregator discards every
// one of those labels anyway (it merges the numbers onto its own axis). Same key
// → same label forever, so a hit is exactly as correct as a miss.
const dayLabelFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', timeZone: BUSINESS_TIMEZONE });
const monthLabelFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: BUSINESS_TIMEZONE });
const labelCache = new Map<string, string>();

function cachedLabel(key: string, build: () => string): string {
  const hit = labelCache.get(key);
  if (hit !== undefined) return hit;
  const label = build();
  // Bounded so a long-running server can't accumulate one entry per date ever
  // charted. Cleared wholesale — an axis is rebuilt in full, so a cold cache
  // costs one range, not one lookup at a time.
  if (labelCache.size >= 5000) labelCache.clear();
  labelCache.set(key, label);
  return label;
}

function dayLabel(iso: string): string {
  return cachedLabel(`d:${iso}`, () => dayLabelFmt.format(new Date(iso + 'T12:00:00Z')));
}
function monthLabel(key: string): string {
  return cachedLabel(`m:${key}`, () => monthLabelFmt.format(new Date(key + '-01T12:00:00Z')));
}

/** Auto-picks granularity so a chart never has to render 200+ bars: day buckets up to ~62 days, month buckets beyond that. */
export function pickGranularity(fromISO: string, toISO: string): PerformanceGranularity {
  const days = (new Date(toISO).getTime() - new Date(fromISO).getTime()) / 86400000;
  return days > 62 ? 'month' : 'day';
}

/** The zero-filled point skeleton for a range — the same x-axis keys/labels
 *  buildPerformanceSummary produces, but derived purely from the dates (no orders
 *  or page-view I/O). Lets the platform aggregator start from the empty axis
 *  without a throwaway summary call over a non-existent store. */
export function buildZeroPoints(fromISO: string, toISO: string, granularity: PerformanceGranularity): PerformancePoint[] {
  return rangeKeys(fromISO, toISO, granularity).map((key) => ({
    key,
    label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    revenueAgorot: 0,
    orders: 0,
    views: 0,
    uniqueVisitors: 0,
  }));
}

/**
 * Builds the seller-facing "store performance" tab's full data set for one store + date range —
 * revenue/orders (from paid orders' storeSubtotals) and visitor counts (from `store-pageviews.ts`)
 * bucketed together onto the same day/month axis, plus a top-products-by-revenue breakdown.
 *
 * **Pure, and page views are now an INPUT.** They used to be read inside this function, one file
 * read per call — which is how the admin performance tab, which calls this once per store, came to
 * do 45 of them per render. Passing them in is what let that become a single query for every store
 * at once (`getStoreViewStats`), and it keeps this function — where all the reporting arithmetic
 * lives — testable without a database. `views` must have been built at the SAME `granularity`,
 * which is why both arrive together.
 */
export function buildPerformanceSummary(
  orders: Order[],
  views: StoreViewStats,
  storeSlug: string,
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
  commissionPercent = 0,
  // How many products to keep in `topProducts`, revenue-sorted. Default 5 for
  // the tab's "leading products" summary; a value <= 0 returns *all* products
  // that sold in the range (the breakdown modal's full-composition view).
  topLimit = 5,
): PerformanceSummary {
  // Membership is decided on the BUSINESS day an order landed on, compared against
  // the range's own business-day bounds — a lexicographic compare of 'YYYY-MM-DD'
  // strings, which is chronological and has no instant arithmetic for a DST change
  // to shift. The range is inclusive of both whole days, which is what the picker's
  // labels promise.
  const inRange = orders.filter((o) => {
    if (!countsAsRevenue(o) || !o.storeSubtotals?.[storeSlug]) return false;
    return dayInRange(businessDayISO(new Date(o.createdAt)), fromISO, toISO);
  });

  const revenueByKey = new Map<string, number>();
  const ordersByKey = new Map<string, number>();
  let totalRevenueAgorot = 0;
  for (const o of inRange) {
    const key = bucketKeyOf(new Date(o.createdAt), granularity);
    const net = orderNetForStore(o, storeSlug);
    revenueByKey.set(key, (revenueByKey.get(key) ?? 0) + net);
    ordersByKey.set(key, (ordersByKey.get(key) ?? 0) + 1);
    totalRevenueAgorot += net;
  }

  const productMap = new Map<string, TopProduct>();
  for (const o of inRange) {
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug) continue;
      const entry = productMap.get(item.productId) ?? { productId: item.productId, name: item.productName, revenueAgorot: 0, units: 0 };
      entry.revenueAgorot += item.priceAgorot * item.qty;
      entry.units += item.qty;
      productMap.set(item.productId, entry);
    }
  }
  const sortedProducts = [...productMap.values()].sort((a, b) => b.revenueAgorot - a.revenueAgorot);

  return assemblePerformanceSummary(
    {
      buckets: [...revenueByKey].map(([key, revenueAgorot]) => ({ key, revenueAgorot, orders: ordersByKey.get(key) ?? 0 })),
      totalRevenueAgorot,
      totalOrders: inRange.length,
    },
    views,
    fromISO,
    toISO,
    granularity,
    commissionPercent,
    topLimit > 0 ? sortedProducts.slice(0, topLimit) : sortedProducts,
  );
}

/**
 * The half of a performance summary that is pure arithmetic over ALREADY-bucketed inputs — the
 * x-axis, the totals, the commission split and the conversion rate.
 *
 * **Split out because the platform tab gets its buckets from the database (§3, 2026-08-03.)**
 * `buildPerformanceSummary` above buckets an order array in JS, which is right for ONE store whose
 * orders the caller already holds; the admin's platform tab asks for every store at once and gets
 * back `order-reporting.ts#getPlatformSales` — one `GROUP BY` instead of a pass over every order,
 * once per store. Both routes end here, so there is exactly one definition of what an average order
 * value, a commission and a conversion rate are.
 *
 * `sales.buckets` may be sparse and in any order; the axis is rebuilt from the dates, so a key that
 * is not on it is dropped and a quiet day still charts as zero rather than as a gap.
 */
export function assemblePerformanceSummary(
  sales: { buckets: readonly { key: string; revenueAgorot: number; orders: number }[]; totalRevenueAgorot: number; totalOrders: number },
  views: StoreViewStats,
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
  commissionPercent = 0,
  topProducts: TopProduct[] = [],
): PerformanceSummary {
  // ── period keys (x-axis), zero-filled so a quiet day/month still shows as 0, not a gap ──
  const keys = rangeKeys(fromISO, toISO, granularity);

  const revenueByKey = new Map<string, number>();
  const ordersByKey = new Map<string, number>();
  for (const b of sales.buckets) {
    revenueByKey.set(b.key, (revenueByKey.get(b.key) ?? 0) + b.revenueAgorot);
    ordersByKey.set(b.key, (ordersByKey.get(b.key) ?? 0) + b.orders);
  }

  // Both numbers arrive already bucketed at this granularity, and the unique counts arrive
  // already DISTINCT — per bucket and, separately, across the whole range. That separation is the
  // point: a visitor who returns on two days of the same month is one unique visitor for that
  // month and one for the range, so the range figure can never be a sum of the buckets. It used to
  // be computed here by unioning the raw visitor-id arrays, which is precisely the unbounded
  // structure the migration removed (DB_MIGRATION_PLAN.md §5).
  const viewsByKey = new Map<string, number>();
  const uniquesByKey = new Map<string, number>();
  for (const b of views.buckets) {
    viewsByKey.set(b.key, (viewsByKey.get(b.key) ?? 0) + b.views);
    uniquesByKey.set(b.key, (uniquesByKey.get(b.key) ?? 0) + b.uniqueVisitors);
  }
  const totalViews = views.totalViews;
  const totalUniqueVisitors = views.totalUniqueVisitors;

  const points: PerformancePoint[] = keys.map((key) => ({
    key,
    label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    revenueAgorot: revenueByKey.get(key) ?? 0,
    orders: ordersByKey.get(key) ?? 0,
    views: viewsByKey.get(key) ?? 0,
    uniqueVisitors: uniquesByKey.get(key) ?? 0,
  }));

  const { totalRevenueAgorot, totalOrders } = sales;

  // A percentage of an integer number of agorot, rounded once to the agora — and through
  // pricing.ts, so this figure and the accrued balance in seller-balance.ts are the same
  // arithmetic rather than two copies of it.
  const platformCommissionAgorot = commissionOnAgorot(totalRevenueAgorot, commissionPercent);
  const netProfitAgorot = totalRevenueAgorot - platformCommissionAgorot;

  // Conversion = orders per *distinct* visitor (the honest "share of people who
  // bought"). Fall back to total loads when no visitor ids exist yet (legacy /
  // demo pageview rows), so the metric never collapses to 0 on seeded data.
  const conversionBase = totalUniqueVisitors > 0 ? totalUniqueVisitors : totalViews;

  return {
    granularity,
    points,
    totalRevenueAgorot,
    totalOrders,
    avgOrderValueAgorot: totalOrders > 0 ? Math.round(totalRevenueAgorot / totalOrders) : 0,
    totalViews,
    totalUniqueVisitors,
    conversionRate: conversionBase > 0 ? (totalOrders / conversionBase) * 100 : 0,
    topProducts,
    commissionRate: commissionPercent,
    platformCommissionAgorot,
    netProfitAgorot,
  };
}

/** Single-product drill-down for the seller's performance tab: units sold, gross
 *  revenue and product-page views for ONE product across a date range, bucketed
 *  on the same day/month axis as the store summary. Both data inputs are passed
 *  in — sales from the orders array, views from `product-pageviews.ts` — so this
 *  stays pure, for the same reason `buildPerformanceSummary` does. */
export function buildProductPerformance(
  orders: Order[],
  views: ProductViewStats,
  storeSlug: string,
  productId: string,
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
): ProductPerformanceSummary {
  const keys = rangeKeys(fromISO, toISO, granularity);

  const unitsByKey = new Map<string, number>();
  const revenueByKey = new Map<string, number>();
  let totalUnits = 0;
  let totalRevenueAgorot = 0;
  let ordersWithProduct = 0;

  for (const o of orders) {
    if (!countsAsRevenue(o)) continue;
    const created = new Date(o.createdAt);
    // Same business-day membership rule as the store summary — the two views sit
    // on the same axis and are read against each other, so they cannot use
    // different definitions of which day a sale happened on.
    if (!dayInRange(businessDayISO(created), fromISO, toISO)) continue;
    let inThisOrder = false;
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug || item.productId !== productId) continue;
      const key = bucketKeyOf(created, granularity);
      unitsByKey.set(key, (unitsByKey.get(key) ?? 0) + item.qty);
      revenueByKey.set(key, (revenueByKey.get(key) ?? 0) + item.priceAgorot * item.qty);
      totalUnits += item.qty;
      totalRevenueAgorot += item.priceAgorot * item.qty;
      inThisOrder = true;
    }
    if (inThisOrder) ordersWithProduct += 1;
  }

  const viewsByKey = new Map<string, number>();
  for (const b of views.buckets) viewsByKey.set(b.key, (viewsByKey.get(b.key) ?? 0) + b.views);
  const totalViews = views.totalViews;

  const points: ProductPerformancePoint[] = keys.map((key) => ({
    key,
    label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    units: unitsByKey.get(key) ?? 0,
    revenueAgorot: revenueByKey.get(key) ?? 0,
    views: viewsByKey.get(key) ?? 0,
  }));

  return {
    productId,
    granularity,
    points,
    totalUnits,
    totalRevenueAgorot,
    totalViews,
    ordersWithProduct,
    conversionRate: totalViews > 0 ? (ordersWithProduct / totalViews) * 100 : 0,
  };
}
