export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getAllStores } from '../../../lib/stores.js';
import { getPlatformSales } from '../../../lib/order-reporting.js';
import { pickGranularity, type PerformanceGranularity } from '../../../lib/seller-performance.js';
import { buildPlatformPerformance, buildPlatformStoreInputs, parseStoreRowsQuery, selectStoreRows } from '../../../lib/platform-performance.js';
import { getPlatformViewStats, getStoreViewStats } from '../../../lib/store-pageviews.js';
import { isDayISO } from '../../../lib/business-day.js';
import { buildPlatformRevenue } from '../../../lib/platform-revenue.js';
import { getCampaignsInRange } from '../../../lib/ad-campaigns.js';
import { getSubscriptionAccrual } from '../../../lib/seller-auth.js';

// Platform-wide (app-wide) twin of /api/admin/performance: same admin guard and
// validation, but aggregates EVERY store instead of one by slug. Returns the
// merged PerformanceSummary (charts/KPIs), the platform's income split
// (commission / subscriptions / ad margin) and ONE PAGE of the per-store
// breakdown — the ?storeQ/storeSort/storeDir/storePage params drive that page,
// so search + paging never reload the dashboard. Read-only reporting, no
// money/stock mutation. All stores are included (blocked ones too, badged in
// the UI) — an admin's view is the whole platform.

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}


export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to || !isDayISO(from) || !isDayISO(to) || from > to) {
    return json({ error: 'Missing or invalid from/to' }, 400);
  }

  // Same bound as the seller/per-store endpoints so a crafted far-past ?from=
  // can't force an unbounded day-bucket series.
  const MAX_DAYS = 731;
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
  if (spanDays < 0 || spanDays > MAX_DAYS) return json({ error: 'Range too large' }, 400);

  const requestedGranularity = url.searchParams.get('granularity');
  const granularity: PerformanceGranularity =
    requestedGranularity === 'day' || requestedGranularity === 'month'
      ? requestedGranularity
      : pickGranularity(from, to);

  // ?products=all → uncap topProducts (the revenue-breakdown donut wants the
  // full per-period composition, not just the top-5 leaderboard).
  const topLimit = url.searchParams.get('products') === 'all' ? 0 : 5;
  // ?productQ= → the leaderboard's own name search. Deliberately separate from ?storeQ: it narrows
  // the product LIST and nothing else — every KPI, chart and store row on the page still describes
  // the whole platform, and each shown product still reports its share of the whole period.
  const productQ = url.searchParams.get('productQ') ?? '';

  const stores = buildPlatformStoreInputs(await getAllStores());
  // Traffic AND sales in one query each, for every store at once. Both used to be per-store passes
  // inside the aggregation loop — views as a file read, sales as a filter over every order on the
  // platform (DB_MIGRATION_PLAN.md §3/§5).
  // `platformViews` is the same traffic question asked WITHOUT the per-store grouping — the only
  // way to count a shopper who opened four stores once (store-pageviews.ts#getPlatformViewStats).
  // In the same Promise.all, so it costs a query and not a round trip.
  const [views, platformViews, sales, campaigns, tiers] = await Promise.all([
    getStoreViewStats(stores.map((s) => s.id), from, to, granularity),
    getPlatformViewStats(stores.map((s) => s.id), from, to, granularity),
    getPlatformSales(stores.map((s) => s.slug), from, to, granularity, topLimit, productQ),
    getCampaignsInRange(from, to),
    getSubscriptionAccrual(from, to),
  ]);
  const result = buildPlatformPerformance(sales, stores, views, from, to, granularity, platformViews);
  const page = selectStoreRows(result.stores, parseStoreRowsQuery(url.searchParams));
  const revenue = buildPlatformRevenue(
    result.summary.platformCommissionAgorot,
    result.summary.commissionRate,
    tiers,
    campaigns,
    from,
    to,
  );

  // `stores`/`totalStores`/`shownStores` keep their original names and shapes —
  // an older deployed client reading them still works (additive-API rule).
  // `storeTotal` is the searched universe (all stores when a query is set,
  // active-only while browsing); `totalStores` stays "active in range".
  return json({
    ok: true,
    summary: result.summary,
    revenue,
    stores: page.rows,
    totalStores: result.totalStores,
    shownStores: page.rows.length,
    storeTotal: page.total,
    storeMatched: page.matched,
    storePage: page.page,
    storeTotalPages: page.totalPages,
    // How many products the name search matched before the top-N cap — the count line under the
    // leaderboard heading. Additive, like everything else added here.
    productsMatched: sales.productsMatched,
  });
}
