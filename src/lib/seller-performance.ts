import type { Order } from './orders.js';
import { orderNetForStore } from './admin-stats.js';
import { getDailyPageViews } from './store-pageviews.js';

export type PerformanceGranularity = 'day' | 'month';

export interface PerformancePoint {
  key: string;   // 'YYYY-MM-DD' (day) or 'YYYY-MM' (month) — stable sort/chart key
  label: string; // pre-formatted for display (Hebrew-aware), so client charts never reformat dates themselves
  revenue: number;
  orders: number;
  views: number;
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
  totalViews: number;
  conversionRate: number; // orders / views * 100, 0 when no views
  topProducts: TopProduct[];
}

function toISODate(d: Date): string { return d.toISOString().slice(0, 10); }
function toMonthKey(d: Date): string { return d.toISOString().slice(0, 7); }

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
  for (const v of dailyViews) {
    const key = granularity === 'day' ? v.date : v.date.slice(0, 7);
    viewsByKey.set(key, (viewsByKey.get(key) ?? 0) + v.views);
  }
  const totalViews = dailyViews.reduce((s, v) => s + v.views, 0);

  const points: PerformancePoint[] = keys.map((key) => ({
    key,
    label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    revenue: revenueByKey.get(key) ?? 0,
    orders: ordersByKey.get(key) ?? 0,
    views: viewsByKey.get(key) ?? 0,
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
  const topProducts = [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  return {
    granularity,
    points,
    totalRevenue,
    totalOrders,
    avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    totalViews,
    conversionRate: totalViews > 0 ? (totalOrders / totalViews) * 100 : 0,
    topProducts,
  };
}
