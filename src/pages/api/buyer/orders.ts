export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { getOrdersByBuyer } from '../../../lib/orders.js';
import { filterBuyerPurchases, parseBuyerOrderQuery, BUYER_ORDER_PAGE_SIZE } from '../../../lib/buyer-orders-query.js';
import { groupBuyerPurchases, countBuyerPurchases } from '../../../lib/buyer-purchases.js';
import { ordersWithOpenReturns, getLatestReturnsByOrder } from '../../../lib/return-requests.js';
import { buyerActionFor } from '../../../lib/returns.js';
import { buyerReturnCta, inStoreReturnAddress } from '../../../lib/return-buyer-cta.js';
import { orderHasNothingReturnable } from '../../../lib/return-eligibility-order.js';
import { getStoresBySlugs } from '../../../lib/stores.js';
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
  // The SAME open-return set the page reads (buyer/dashboard.astro). Without it a tab refresh would
  // rewrite the list with a different active/history split than the one that was painted, and an
  // order with a live return would jump between tabs on every poll.
  const openReturnOrderIds = await ordersWithOpenReturns(orders.map((o) => o.id));
  const allPurchases = groupBuyerPurchases(orders, openReturnOrderIds);
  const filtered = filterBuyerPurchases(allPurchases, query);
  const page = paginate(filtered, parsePage(url.searchParams, 'page'), BUYER_ORDER_PAGE_SIZE);

  // Both sub-tab totals, not just the one being asked for — `total` above counts the CURRENT
  // filter, so a client refreshing the active list could never learn that history had grown. Free
  // here: the grouping it counts is the same one the page above was cut from, no second read.
  const counts = countBuyerPurchases(allPurchases);

  // ── What the buyer may DO with each order, decided here and not in the browser ──
  //
  // The bug this closes (found by a parallel session, 2026-08-17): the return button was rendered by
  // the server on first paint and by a JS twin after any search or page change — and the twin knew
  // nothing about returns, so the button vanished until a refresh. That is this repo's twin-renderer
  // class (memory `project_client_renderer_i18n_drift`), and the fix is the same one it always is:
  // the decision travels in the payload, and the renderer only draws.
  //
  // Three facts per order, all of them already computable here: which act applies, whether a request
  // is already running, and whether the regulations leave anything returnable at all.
  const pageOrders = page.items.flatMap((p) => p.slices.map((s) => s.order));
  const latestReturns = await getLatestReturnsByOrder(pageOrders.map((o) => o.id));
  const storeById = new Map(
    (await getStoresBySlugs([...new Set(pageOrders.flatMap((o) => Object.keys(o.storeSubtotals ?? {})))]))
      .map((st) => [st.slug, st]),
  );
  const blocked = new Set<string>();
  await Promise.all(pageOrders.map(async (o) => {
    if (buyerActionFor(o) !== 'return') return;
    const st = storeById.get(Object.keys(o.storeSubtotals ?? {})[0] ?? '');
    if (st && await orderHasNothingReturnable(o, st.id)) blocked.add(o.id);
  }));

  const purchases = page.items.map((p) => ({
    ...p,
    slices: p.slices.map((s) => {
      const rr = latestReturns.get(s.order.id);
      return {
        ...s,
        order: publicOrder(s.order),
        // `null` when there is nothing to offer — the renderer draws neither a button nor a status,
        // which is what "the button only appears when it can actually work" means on this side.
        returnAction: blocked.has(s.order.id) ? 'none' : buyerActionFor(s.order),
        returnStatus: rr?.status ?? null,
        returnRefundAgorot: rr?.refundAgorot ?? null,
        // What the buyer may PRESS on a case that already exists — decided here for the same reason
        // `returnAction` is. These buttons lived in the server's markup only, so a buyer who searched
        // his orders lost the only way to answer an offer or say he had sent the product back; the
        // twin cannot be trusted with a rule, only with drawing one (`lib/return-buyer-cta.ts`).
        returnCta: rr ? buyerReturnCta(rr) : { buttons: [] },
        returnId: rr?.id ?? null,
        returnPartialOfferAgorot: rr?.partialOfferAgorot ?? null,
        // A shop that offers collection in person must also take returns in person (owner,
        // 2026-08-17), so the address travels with the case rather than being looked up in the browser.
        returnInStoreAddress: inStoreReturnAddress(storeById.get(s.storeSlug)),
      };
    }),
  }));
  // `items` is the same page flattened back to order rows, and it is here for ONE deploy: during
  // a rolling deploy the previous page bundle is still in someone's browser calling this route,
  // and it renders `items`. Additive, per the zero-downtime rule (AI_INSTRUCTIONS → Hard rules) —
  // that client shows one card per store for a few seconds, which is exactly what it did before,
  // rather than an empty list. Drop it in a later deploy, not in the same one.
  const items = purchases.flatMap((p) => p.slices.map((s) => s.order));
  return json({
    ok: true,
    purchases,
    items,
    page: page.page,
    totalPages: page.totalPages,
    total: page.total,
    counts,
  });
};
