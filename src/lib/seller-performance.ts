import type { Order } from './orders.js';
import { orderNetForStore } from './admin-stats.js';
import { getDailyPageViews } from './store-pageviews.js';
import { getProductDailyViews } from './product-pageviews.js';

export type PerformanceGranularity = 'day' | 'month';

export interface PerformancePoint {
  key: string;   // 'YYYY-MM-DD' (day) or 'YYYY-MM' (month) — stable sort/chart key
  label: string; // pre-formatted for display (Hebrew-aware), so client charts never reformat dates themselves
  revenue: number;
  orders: number;
  views: number;          // total loads in this bucket (repeat visits counted)
  uniqueVisitors: number; // distinct visitor ids in this bucket (unioned, not summed, across its days)
}

export interface TopProduct {
  productId: string;
  name: string;
  revenue: number; // gross (pre order-level discount — discount is only stored per store-subtotal, not per item)
  units: number;
}

export interface PerformanceSummary {
  granularity: PerformanceGranularity;
  points: PerformancePoint[];
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  totalViews: number;          // total loads across the range (repeat visits counted)
  totalUniqueVisitors: number; // distinct visitors across the whole range (a returning visitor counts once)
  conversionRate: number; // orders / unique-visitors * 100 (falls back to total views when no visitor ids exist, e.g. legacy/demo data), 0 when neither
  topProducts: TopProduct[];
  // Profitability (reporting only — the real deduction happens at the
  // split-payment processor). commissionRate is echoed back so the client can
  // label the expense line ("platform commission (10%)") without re-reading
  // store.config; platformCommission/netProfit are pre-computed server-side so
  // SSR and the AJAX re-render can never drift on the rounding.
  commissionRate: number;      // percent, e.g. 10
  platformCommission: number;  // totalRevenue * commissionRate / 100, the seller's expense
  netProfit: number;           // totalRevenue - platformCommission, what the seller actually receives
}

export interface ProductPerformancePoint {
  key: string;   // 'YYYY-MM-DD' (day) or 'YYYY-MM' (month)
  label: string; // pre-formatted, Hebrew-aware
  units: number;
  revenue: number; // gross (pre order-level discount, same basis as TopProduct.revenue)
  views: number;   // product-page loads in this bucket
}

export interface ProductPerformanceSummary {
  productId: string;
  granularity: PerformanceGranularity;
  points: ProductPerformancePoint[];
  totalUnits: number;
  totalRevenue: number;
  totalViews: number;
  ordersWithProduct: number; // distinct paid orders in range that contained this product
  conversionRate: number;    // ordersWithProduct / totalViews * 100, 0 when no views
}

function toISODate(d: Date): string { return d.toISOString().slice(0, 10); }
function toMonthKey(d: Date): string { return d.toISOString().slice(0, 7); }

/** The zero-filled x-axis keys for a range at a given granularity — shared by the store and per-product builders so their bars line up on the same axis. */
function rangeKeys(fromISO: string, toISO: string, granularity: PerformanceGranularity): string[] {
  const from = new Date(fromISO + 'T00:00:00.000Z');
  const to = new Date(toISO + 'T23:59:59.999Z');
  const keys: string[] = [];
  if (granularity === 'day') {
    const cur = new Date(from);
    while (cur <= to) { keys.push(toISODate(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  } else {
    const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    while (cur <= end) { keys.push(toMonthKey(cur)); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  }
  return keys;
}

function dayLabel(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}
function monthLabel(key: string): string {
  return new Date(key + '-01T00:00:00Z').toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/** Auto-picks granularity so a chart never has to render 200+ bars: day buckets up to ~62 days, month buckets beyond that. */
export function pickGranularity(fromISO: string, toISO: string): PerformanceGranularity {
  const days = (new Date(toISO).getTime() - new Date(fromISO).getTime()) / 86400000;
  return days > 62 ? 'month' : 'day';
}

/** Builds the seller-facing "store performance" tab's full data set for one store + date range — revenue/orders (from paid orders' storeSubtotals) and visitor counts (from store-pageviews.ts) bucketed together onto the same day/month axis, plus a top-products-by-revenue breakdown. Pure given its inputs (orders array is the only "money" data; page views are read internally since they're already a cheap aggregate, not per-request data worth threading through every caller). */
export function buildPerformanceSummary(
  orders: Order[],
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
  const from = new Date(fromISO + 'T00:00:00.000Z');
  const to = new Date(toISO + 'T23:59:59.999Z');

  const inRange = orders.filter((o) => {
    if (o.paymentStatus !== 'paid' || !o.storeSubtotals[storeSlug]) return false;
    const c = new Date(o.createdAt);
    return c >= from && c <= to;
  });

  // ── period keys (x-axis), zero-filled so a quiet day/month still shows as 0, not a gap ──
  const keys: string[] = [];
  if (granularity === 'day') {
    const cur = new Date(from);
    while (cur <= to) { keys.push(toISODate(cur)); cur.setUTCDate(cur.getUTCDate() + 1); }
  } else {
    const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    while (cur <= end) { keys.push(toMonthKey(cur)); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  }

  const bucketOf = (d: Date) => (granularity === 'day' ? toISODate(d) : toMonthKey(d));

  const revenueByKey = new Map<string, number>();
  const ordersByKey = new Map<string, number>();
  let totalRevenue = 0;
  for (const o of inRange) {
    const key = bucketOf(new Date(o.createdAt));
    const net = orderNetForStore(o, storeSlug);
    revenueByKey.set(key, (revenueByKey.get(key) ?? 0) + net);
    ordersByKey.set(key, (ordersByKey.get(key) ?? 0) + 1);
    totalRevenue += net;
  }

  const dailyViews = getDailyPageViews(storeSlug, fromISO, toISO);
  const viewsByKey = new Map<string, number>();
  // Unique visitors are unioned per bucket (and across the whole range), never
  // summed — a visitor returning on two days in the same month is still one
  // unique visitor for that month, and the range total de-dupes across buckets.
  const visitorsByKey = new Map<string, Set<string>>();
  const allVisitors = new Set<string>();
  for (const v of dailyViews) {
    const key = granularity === 'day' ? v.date : v.date.slice(0, 7);
    viewsByKey.set(key, (viewsByKey.get(key) ?? 0) + v.views);
    let set = visitorsByKey.get(key);
    if (!set) { set = new Set<string>(); visitorsByKey.set(key, set); }
    for (const id of v.visitors) { set.add(id); allVisitors.add(id); }
  }
  const totalViews = dailyViews.reduce((s, v) => s + v.views, 0);
  const totalUniqueVisitors = allVisitors.size;

  const points: PerformancePoint[] = keys.map((key) => ({
    key,
    label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    revenue: revenueByKey.get(key) ?? 0,
    orders: ordersByKey.get(key) ?? 0,
    views: viewsByKey.get(key) ?? 0,
    uniqueVisitors: visitorsByKey.get(key)?.size ?? 0,
  }));

  const totalOrders = inRange.length;

  const productMap = new Map<string, TopProduct>();
  for (const o of inRange) {
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug) continue;
      const entry = productMap.get(item.productId) ?? { productId: item.productId, name: item.productName, revenue: 0, units: 0 };
      entry.revenue += item.price * item.qty;
      entry.units += item.qty;
      productMap.set(item.productId, entry);
    }
  }
  const sortedProducts = [...productMap.values()].sort((a, b) => b.revenue - a.revenue);
  const topProducts = topLimit > 0 ? sortedProducts.slice(0, topLimit) : sortedProducts;

  const platformCommission = Math.round(totalRevenue * commissionPercent) / 100;
  const netProfit = Math.round((totalRevenue - platformCommission) * 100) / 100;

  // Conversion = orders per *distinct* visitor (the honest "share of people who
  // bought"). Fall back to total loads when no visitor ids exist yet (legacy /
  // demo pageview rows), so the metric never collapses to 0 on seeded data.
  const conversionBase = totalUniqueVisitors > 0 ? totalUniqueVisitors : totalViews;

  return {
    granularity,
    points,
    totalRevenue,
    totalOrders,
    avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    totalViews,
    totalUniqueVisitors,
    conversionRate: conversionBase > 0 ? (totalOrders / conversionBase) * 100 : 0,
    topProducts,
    commissionRate: commissionPercent,
    platformCommission,
    netProfit,
  };
}

/** Single-product drill-down for the seller's performance tab: units sold, gross
 *  revenue and product-page views for ONE product across a date range, bucketed
 *  on the same day/month axis as the store summary. Sales come from the orders
 *  array (the "money" data, passed in); views are read internally from
 *  product-pageviews.ts (a cheap pre-aggregate, same pattern as the store
 *  summary's page views). Pure given its inputs + that store. */
export function buildProductPerformance(
  orders: Order[],
  storeSlug: string,
  productId: string,
  fromISO: string,
  toISO: string,
  granularity: PerformanceGranularity,
): ProductPerformanceSummary {
  const from = new Date(fromISO + 'T00:00:00.000Z');
  const to = new Date(toISO + 'T23:59:59.999Z');
  const keys = rangeKeys(fromISO, toISO, granularity);
  const bucketOf = (d: Date) => (granularity === 'day' ? toISODate(d) : toMonthKey(d));

  const unitsByKey = new Map<string, number>();
  const revenueByKey = new Map<string, number>();
  let totalUnits = 0;
  let totalRevenue = 0;
  let ordersWithProduct = 0;

  for (const o of orders) {
    if (o.paymentStatus !== 'paid') continue;
    const created = new Date(o.createdAt);
    if (created < from || created > to) continue;
    let inThisOrder = false;
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug || item.productId !== productId) continue;
      const key = bucketOf(created);
      unitsByKey.set(key, (unitsByKey.get(key) ?? 0) + item.qty);
      revenueByKey.set(key, (revenueByKey.get(key) ?? 0) + item.price * item.qty);
      totalUnits += item.qty;
      totalRevenue += item.price * item.qty;
      inThisOrder = true;
    }
    if (inThisOrder) ordersWithProduct += 1;
  }

  const dailyViews = getProductDailyViews(productId, fromISO, toISO);
  const viewsByKey = new Map<string, number>();
  for (const v of dailyViews) {
    const key = granularity === 'day' ? v.date : v.date.slice(0, 7);
    viewsByKey.set(key, (viewsByKey.get(key) ?? 0) + v.views);
  }
  const totalViews = dailyViews.reduce((s, v) => s + v.views, 0);

  const points: ProductPerformancePoint[] = keys.map((key) => ({
    key,
    label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    units: unitsByKey.get(key) ?? 0,
    revenue: Math.round((revenueByKey.get(key) ?? 0) * 100) / 100,
    views: viewsByKey.get(key) ?? 0,
  }));

  return {
    productId,
    granularity,
    points,
    totalUnits,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalViews,
    ordersWithProduct,
    conversionRate: totalViews > 0 ? (ordersWithProduct / totalViews) * 100 : 0,
  };
}
