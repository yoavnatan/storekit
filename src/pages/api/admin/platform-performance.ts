export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getAllStores } from '../../../lib/stores.js';
import { getAllOrders } from '../../../lib/orders.js';
import { pickGranularity, type PerformanceGranularity } from '../../../lib/seller-performance.js';
import { buildPlatformPerformance } from '../../../lib/platform-performance.js';
import { store as platformConfig } from '../../../config/store.config.js';

// Platform-wide (app-wide) twin of /api/admin/performance: same admin guard and
// validation, but aggregates EVERY store instead of one by slug. Returns the
// merged PerformanceSummary (charts/KPIs) plus the per-store breakdown rows.
// Read-only reporting, no money/stock mutation. All stores are included
// (blocked ones too, badged in the UI) — an admin's view is the whole platform.

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to || !ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
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

  const orders = getAllOrders();
  const stores = getAllStores().map((s) => ({ slug: s.slug, name: s.name, blocked: s.blocked }));
  const result = buildPlatformPerformance(orders, stores, from, to, granularity, platformConfig.checkout.commissionPercent, topLimit);

  return json({ ok: true, summary: result.summary, stores: result.stores, totalStores: result.totalStores, shownStores: result.shownStores });
}
