import type { Order } from './orders.js';
import {
  buildPerformanceSummary,
  buildZeroPoints,
  type PerformanceGranularity,
  type PerformancePoint,
  type PerformanceSummary,
  type TopProduct,
} from './seller-performance.js';
import { blendedCommissionRate, commissionPercentForTier } from './pricing.js';

// Platform-wide ("app-wide") twin of seller-performance.ts's per-store summary,
// for the ADMIN performance tab. It does NOT re-implement any of the bucketing/
// revenue/views math — it calls buildPerformanceSummary() once per store (the
// single source of that math) and merges the results, so the platform totals
// can never drift from what each store's own performance view reports. The only
// platform-specific logic here is the merge + the per-store breakdown rows.
//
// Cost note (JSON-file era): buildPerformanceSummary reads store-pageviews.json
// internally per call, so this is O(stores) file reads today — the same
// deliberate "cheap now, one indexed query after the DB migration" tradeoff the
// header's SSR indicators already make (see AI_INSTRUCTIONS.md → Scalability).
// The function signature stays identical when that read becomes a DB query.

export interface PlatformStoreInput {
  slug: string;
  name: string;
  blocked?: boolean;
  /** This store's per-sale commission percent, from its SELLER's pricing tier (lib/pricing.ts).
   *  Passed in per store rather than as one platform-wide rate: sellers sit on different tiers,
   *  so a single number would silently misreport the moment the second tier is sold. Absent = 0. */
  commissionPercent?: number;
}

/** Attaches each store's commission rate, resolved from its OWNER's pricing tier — the one place
 *  the store→seller→tier hop is written, so both admin call sites (the dashboard render and the
 *  AJAX endpoint) can never disagree. Pure: the caller supplies both already-read lists. */
export function buildPlatformStoreInputs(
  stores: Array<{ slug: string; name: string; blocked?: boolean; sellerId: string }>,
  sellers: Array<{ id: string; tier?: string }>,
): PlatformStoreInput[] {
  const tierBySellerId = new Map(sellers.map((s) => [s.id, s.tier]));
  return stores.map((s) => ({
    slug: s.slug,
    name: s.name,
    blocked: s.blocked,
    commissionPercent: commissionPercentForTier(tierBySellerId.get(s.sellerId)),
  }));
}

// One row of the "breakdown by store" table — the same headline metrics each
// store's own performance tab shows, so an owner can see which stores actually
// drive the platform.
export interface PlatformStoreRow {
  slug: string;
  name: string;
  blocked: boolean;
  revenue: number;      // net of seller discount, paid orders only (same basis as seller tab)
  orders: number;       // orders that included this store, in range
  views: number;        // store page views in range
  conversionRate: number; // orders / unique-visitors * 100 (per-store, from buildPerformanceSummary)
}

export interface PlatformPerformance {
  // Aggregated across every store — identical shape to a single store's summary
  // so the exact same charts / KPI markup / client script (performance.ts) can
  // render it unchanged. `platformCommission`/`netProfit` are re-purposed by the
  // admin panel's LABELS: at platform level the commission is the platform's own
  // income and netProfit is what gets paid out to sellers (the numbers are the
  // same, only the framing differs from the seller's expense view).
  summary: PerformanceSummary;
  stores: PlatformStoreRow[]; // revenue-desc, capped at storeLimit
  totalStores: number;        // stores with any activity in range, before the cap
  shownStores: number;        // rows actually returned (min(totalStores, storeLimit))
}

// Bound the breakdown so 1000 stores can't render an unbounded table on one
// page — mirrors the admin dashboard's own list caps (see AI_INSTRUCTIONS.md →
// admin pagination). The top revenue-drivers are what an owner scans for; the
// panel shows a "top N of M" note when the cap bites.
export const TOP_STORES_LIMIT = 25;

/**
 * Aggregates every store's performance into one platform-wide PerformanceSummary
 * plus a per-store breakdown, over [fromISO, toISO]. Pure given its inputs
 * (orders array is the money data; page views are read inside buildPerformanceSummary
 * per store, matching the seller path). `topLimit` caps the aggregated topProducts
 * (default 5; <=0 = all, for the revenue-breakdown modal). `storeLimit` caps the
 * breakdown rows.
 *
 * Note: unique visitors are SUMMED across stores (a browser visiting two stores
 * is counted once per store), so the platform figure is an upper bound — the
 * per-store visitor-id sets aren't unioned across stores here. Acceptable for an
 * owner-facing overview; exact cross-store de-dup would need the raw id sets.
 */
export function buildPlatformPerformance(
  orders: Order[],
  stores: PlatformStoreInput[],
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
  topLimit = 5,
  storeLimit = TOP_STORES_LIMIT,
): PlatformPerformance {
  // Zero-filled point skeleton for the whole range, derived straight from the
  // dates — the exact x-axis keys/labels the seller math produces, so the merge
  // below just adds onto it (an empty platform still charts a flat range, not a
  // blank box) without a throwaway summary pass over a fake store.
  const points: PerformancePoint[] = buildZeroPoints(fromISO, toISO, granularity);
  const keyIndex = new Map(points.map((p, i) => [p.key, i]));

  const productMap = new Map<string, TopProduct>();
  const rows: PlatformStoreRow[] = [];
  let totalRevenue = 0;
  // Orders are summed per store: a rare multi-store order counts toward each
  // store it touched, so the platform "orders" figure reconciles exactly with
  // the sum of the breakdown rows (what the owner sees when scanning the table).
  let totalOrders = 0;
  let totalViews = 0;
  let totalUniqueVisitors = 0;
  // Summed from each store's OWN tier rate — never one rate applied to the platform total.
  let totalCommission = 0;

  for (const store of stores) {
    // topLimit 0 here → the store contributes ALL its sold products to the
    // platform product aggregation, so the platform top-N is a true top-N and
    // not a top-N-of-each-store's-top-5.
    const s = buildPerformanceSummary(orders, store.slug, fromISO, toISO, granularity, store.commissionPercent ?? 0, 0);
    totalRevenue += s.totalRevenue;
    totalCommission += s.platformCommission;
    totalOrders += s.totalOrders;
    totalViews += s.totalViews;
    totalUniqueVisitors += s.totalUniqueVisitors;

    for (const p of s.points) {
      const i = keyIndex.get(p.key);
      if (i === undefined) continue;
      points[i]!.revenue += p.revenue;
      points[i]!.orders += p.orders;
      points[i]!.views += p.views;
      points[i]!.uniqueVisitors += p.uniqueVisitors;
    }

    for (const tp of s.topProducts) {
      const entry = productMap.get(tp.productId) ?? { productId: tp.productId, name: tp.name, revenue: 0, units: 0 };
      entry.revenue += tp.revenue;
      entry.units += tp.units;
      productMap.set(tp.productId, entry);
    }

    // Only stores with any activity in the range make the breakdown — a store
    // with no orders and no views in the window is noise in the table.
    if (s.totalRevenue > 0 || s.totalOrders > 0 || s.totalViews > 0) {
      rows.push({
        slug: store.slug,
        name: store.name,
        blocked: store.blocked ?? false,
        revenue: s.totalRevenue,
        orders: s.totalOrders,
        views: s.totalViews,
        conversionRate: s.conversionRate,
      });
    }
  }

  const sortedProducts = [...productMap.values()].sort((a, b) => b.revenue - a.revenue);
  const topProducts = topLimit > 0 ? sortedProducts.slice(0, topLimit) : sortedProducts;

  const platformCommission = Math.round(totalCommission * 100) / 100;
  const netProfit = Math.round((totalRevenue - platformCommission) * 100) / 100;
  // Conversion = orders / unique visitors (matches the seller tab's definition),
  // falling back to total views when no visitor ids exist (legacy/demo data).
  const conversionRate = totalUniqueVisitors > 0
    ? (totalOrders / totalUniqueVisitors) * 100
    : totalViews > 0 ? (totalOrders / totalViews) * 100 : 0;

  const summary: PerformanceSummary = {
    granularity,
    points,
    totalRevenue,
    totalOrders,
    avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    totalViews,
    totalUniqueVisitors,
    conversionRate,
    topProducts,
    // Revenue-weighted actual, not any one tier's rate — the only honest headline across a
    // mixed-tier seller base (see pricing.ts#blendedCommissionRate).
    commissionRate: blendedCommissionRate(totalRevenue, platformCommission),
    platformCommission,
    netProfit,
  };

  const sortedRows = rows.sort((a, b) => b.revenue - a.revenue);
  return {
    summary,
    stores: sortedRows.slice(0, storeLimit),
    totalStores: sortedRows.length,
    shownStores: Math.min(sortedRows.length, storeLimit),
  };
}
