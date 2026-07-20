export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlug } from '../../../lib/orders.js';
import { getProductById } from '../../../lib/store-products.js';
import { buildPerformanceSummary, buildProductPerformance, pickGranularity, type PerformanceGranularity } from '../../../lib/seller-performance.js';
import { store as platformConfig } from '../../../config/store.config.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!storeSlug || !from || !to || !ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return json({ error: 'Missing or invalid storeSlug/from/to' }, 400);
  }

  const stores = getStoresBySellerId(sellerId);
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Cap the window so a crafted ?from= far in the past can't force building
  // an unbounded day-bucket series (each day is a real array entry).
  const MAX_DAYS = 731;
  const spanDays = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
  if (spanDays < 0 || spanDays > MAX_DAYS) return json({ error: 'Range too large' }, 400);

  const requestedGranularity = url.searchParams.get('granularity');
  const granularity: PerformanceGranularity =
    requestedGranularity === 'day' || requestedGranularity === 'month'
      ? requestedGranularity
      : pickGranularity(from, to);

  // ?products=all → uncap topProducts (breakdown modal wants the full
  // composition, not just the tab's top-5 leaderboard).
  const topLimit = url.searchParams.get('products') === 'all' ? 0 : 5;

  const orders = getOrdersByStoreSlug(storeSlug);

  // ?productId=… → single-product drill-down (sales + views for that product,
  // same range/axis). The product must belong to THIS store, else a crafted id
  // could read another store's product views/sales. Returned alongside the store
  // summary so the tab can render both from one fetch.
  const productId = url.searchParams.get('productId');
  if (productId) {
    const product = getProductById(productId);
    if (!product || product.storeId !== store.id) return json({ error: 'Product not found' }, 404);
    const productSummary = buildProductPerformance(orders, storeSlug, productId, from, to, granularity);
    return json({ ok: true, product: productSummary, productName: product.name });
  }

  const summary = buildPerformanceSummary(orders, storeSlug, from, to, granularity, platformConfig.checkout.commissionPercent, topLimit);
  return json({ ok: true, summary });
}
