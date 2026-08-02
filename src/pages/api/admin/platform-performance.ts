export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getAllStores } from '../../../lib/stores.js';
import { getAllOrders } from '../../../lib/orders.js';
import { pickGranularity, type PerformanceGranularity } from '../../../lib/seller-performance.js';
import { buildPlatformPerformance, buildPlatformStoreInputs, parseStoreRowsQuery, selectStoreRows } from '../../../lib/platform-performance.js';
import { getStoreViewStats } from '../../../lib/store-pageviews.js';
import { isDayISO } from '../../../lib/business-day.js';
import { buildPlatformRevenue } from '../../../lib/platform-revenue.js';
import { getAllCampaigns } from '../../../lib/ad-campaigns.js';
import { getAllSellers } from '../../../lib/seller-auth.js';

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

  const orders = await getAllOrders();
  const sellers = await getAllSellers();
  const stores = buildPlatformStoreInputs(await getAllStores(), sellers);
  // Every store's traffic in ONE query. This used to be a file read per store inside the loop
  // below (45 of them per render) — see platform-performance.ts's cost note.
  const views = await getStoreViewStats(stores.map((s) => s.id), from, to, granularity);
  const result = buildPlatformPerformance(orders, stores, views, from, to, granularity, topLimit);
  const page = selectStoreRows(result.stores, parseStoreRowsQuery(url.searchParams));
  const revenue = buildPlatformRevenue(
    result.summary.platformCommissionAgorot,
    result.summary.commissionRate,
    sellers,
    getAllCampaigns(),
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
  });
}
