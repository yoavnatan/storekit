export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug } from '../../../lib/stores.js';
import { getOrdersByStoreSlug } from '../../../lib/orders.js';
import { buildPerformanceSummary, pickGranularity, type PerformanceGranularity } from '../../../lib/seller-performance.js';
import { store as platformConfig } from '../../../config/store.config.js';

// Admin-facing twin of /api/seller/performance: identical validation and
// PerformanceSummary shape, but gated by the admin cookie (requireAdmin) and
// able to read ANY store by slug — the seller route is scoped to the caller's
// own session-owned stores, the admin owns none, so slug is the only key here.
// Read-only reporting (no money/stock mutation), same as the seller endpoint.

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  // Admin cookie is the only gate — never a seller session. requireAdmin
  // returns a ready 401 Response when the caller isn't the admin.
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!storeSlug || !from || !to || !ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return json({ error: 'Missing or invalid storeSlug/from/to' }, 400);
  }

  const store = getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Cap the window so a crafted ?from= far in the past can't force building an
  // unbounded day-bucket series (each day is a real array entry) — mirrors the
  // seller endpoint's own MAX_DAYS guard.
  const MAX_DAYS = 731;
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
  if (spanDays < 0 || spanDays > MAX_DAYS) return json({ error: 'Range too large' }, 400);

  const requestedGranularity = url.searchParams.get('granularity');
  const granularity: PerformanceGranularity =
    requestedGranularity === 'day' || requestedGranularity === 'month'
      ? requestedGranularity
      : pickGranularity(from, to);

  // ?products=all → uncap topProducts (the breakdown modal wants the full
  // per-period composition, not just the top-5 leaderboard).
  const topLimit = url.searchParams.get('products') === 'all' ? 0 : 5;

  const orders = getOrdersByStoreSlug(storeSlug);
  const summary = buildPerformanceSummary(orders, storeSlug, from, to, granularity, platformConfig.checkout.commissionPercent, topLimit);
  return json({ ok: true, summary });
}
