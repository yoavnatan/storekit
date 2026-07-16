export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { getAllOrders } from '../../../lib/orders.js';
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

  const seller = getSellerById(userId);
  if (!seller) return json({ error: 'User not found' }, 404);

  const url = new URL(request.url);
  const orders = getAllOrders()
    .filter((o) => o.buyerId === userId || o.buyerEmail === seller.email)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const query = parseBuyerOrderQuery(url.searchParams);
  const filtered = filterBuyerOrders(orders, query);
  const page = paginate(filtered, parsePage(url.searchParams, 'page'), BUYER_ORDER_PAGE_SIZE);

  return json({ ok: true, items: page.items, page: page.page, totalPages: page.totalPages, total: page.total });
};
