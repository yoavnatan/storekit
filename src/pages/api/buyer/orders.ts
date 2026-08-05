export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { getOrdersByBuyer } from '../../../lib/orders.js';
import { filterBuyerPurchases, parseBuyerOrderQuery, BUYER_ORDER_PAGE_SIZE } from '../../../lib/buyer-orders-query.js';
import { groupBuyerPurchases } from '../../../lib/buyer-purchases.js';
import { paginate, parsePage } from '../../../lib/pagination.js';
import type { Order } from '../../../lib/orders.js';

/** The sellers' private per-store notes must never reach the buyer. `attribution` goes with them:
 *  it is the platform's own ad bookkeeping (which campaign produced this order), nothing on this
 *  screen reads it, and echoing a shopper's click id back into their browser is the opposite of
 *  keeping it in an httpOnly cookie. Both are dropped by NAME because the line spreads a whole
 *  `Order` and therefore inherits every field the model gains — which is how `sellerNotes` reached
 *  a client in the first place. */
function publicOrder({ sellerNotes, attribution, ...rest }: Order): Omit<Order, 'sellerNotes' | 'attribution'> {
  return rest;
}

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
  // Grouped BEFORE filtering and paging: a page is five purchases (buyer-orders-query.ts).
  const filtered = filterBuyerPurchases(groupBuyerPurchases(orders), query);
  const page = paginate(filtered, parsePage(url.searchParams, 'page'), BUYER_ORDER_PAGE_SIZE);

  const purchases = page.items.map((p) => ({
    ...p,
    slices: p.slices.map((s) => ({ ...s, order: publicOrder(s.order) })),
  }));
  // `items` is the same page flattened back to order rows, and it is here for ONE deploy: during
  // a rolling deploy the previous page bundle is still in someone's browser calling this route,
  // and it renders `items`. Additive, per the zero-downtime rule (AI_INSTRUCTIONS → Hard rules) —
  // that client shows one card per store for a few seconds, which is exactly what it did before,
  // rather than an empty list. Drop it in a later deploy, not in the same one.
  const items = purchases.flatMap((p) => p.slices.map((s) => s.order));
  return json({ ok: true, purchases, items, page: page.page, totalPages: page.totalPages, total: page.total });
};
