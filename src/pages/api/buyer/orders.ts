export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { getOrdersByBuyer } from '../../../lib/orders.js';
import { filterBuyerOrders, parseBuyerOrderQuery, BUYER_ORDER_PAGE_SIZE } from '../../../lib/buyer-orders-query.js';
import { paginate, parsePage } from '../../../lib/pagination.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const seller = await getSellerById(userId);
  if (!seller) return json({ error: 'User not found' }, 404);

  const url = new URL(request.url);
  // One WHERE, not "every order on the platform, then filter". Already newest-first from the
  // query, on the same id-OR-email match a guest checkout needs (orders.ts#getOrdersByBuyer).
  const orders = await getOrdersByBuyer(userId, seller.email);

  const query = parseBuyerOrderQuery(url.searchParams);
  const filtered = filterBuyerOrders(orders, query);
  const page = paginate(filtered, parsePage(url.searchParams, 'page'), BUYER_ORDER_PAGE_SIZE);

  // Strip the sellers' private per-store notes — they must never reach the buyer.
  const items = page.items.map(({ sellerNotes, ...rest }) => rest);
  return json({ ok: true, items, page: page.page, totalPages: page.totalPages, total: page.total });
};
