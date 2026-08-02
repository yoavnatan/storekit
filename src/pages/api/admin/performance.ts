export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug } from '../../../lib/stores.js';
import { getOrdersByStoreSlug } from '../../../lib/orders.js';
import { getProductById } from '../../../lib/store-products.js';
import { buildPerformanceSummary, buildProductPerformance, pickGranularity, type PerformanceGranularity } from '../../../lib/seller-performance.js';
import { getViewStatsForStore } from '../../../lib/store-pageviews.js';
import { getProductViewStats } from '../../../lib/product-pageviews.js';
import { isDayISO } from '../../../lib/business-day.js';
import { commissionPercentForTier } from '../../../lib/pricing.js';
import { getSellerById } from '../../../lib/seller-auth.js';

// Admin-facing twin of /api/seller/performance: identical validation and
// PerformanceSummary shape, but gated by the admin cookie (requireAdmin) and
// able to read ANY store by slug — the seller route is scoped to the caller's
// own session-owned stores, the admin owns none, so slug is the only key here.
// Read-only reporting (no money/stock mutation), same as the seller endpoint.

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}


export async function GET({ request, cookies }: APIContext): Promise<Response> {
  // Admin cookie is the only gate — never a seller session. requireAdmin
  // returns a ready 401 Response when the caller isn't the admin.
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!storeSlug || !from || !to || !isDayISO(from) || !isDayISO(to) || from > to) {
    return json({ error: 'Missing or invalid storeSlug/from/to' }, 400);
  }

  const store = await getStoreBySlug(storeSlug);
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

  // ?productId=… → single-product drill-down, same as the seller twin. Product
  // must belong to the requested store (defence-in-depth even though admin sees
  // all — keeps a mismatched id from reading an unrelated product's numbers).
  const productId = url.searchParams.get('productId');
  if (productId) {
    const product = await getProductById(productId);
    if (!product || product.storeId !== store.id) return json({ error: 'Product not found' }, 404);
    const [orders, productViews] = await Promise.all([
      getOrdersByStoreSlug(storeSlug),
      getProductViewStats(productId, from, to, granularity),
    ]);
    const productSummary = buildProductPerformance(orders, productViews, storeSlug, productId, from, to, granularity);
    return json({ ok: true, product: productSummary, productName: product.name });
  }

  const [orders, views, seller] = await Promise.all([
    getOrdersByStoreSlug(storeSlug),
    getViewStatsForStore(store.id, from, to, granularity),
    getSellerById(store.sellerId),
  ]);
  const summary = buildPerformanceSummary(orders, views, storeSlug, from, to, granularity, commissionPercentForTier(seller?.tier), topLimit);
  return json({ ok: true, summary });
}
