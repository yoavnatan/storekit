export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { isAdminRequest } from '../../lib/admin-auth.js';
import { getStoresBySellerId, getStoreBySlugOrPrevious } from '../../lib/stores.js';
import { getOrderById, orderBelongsToStore } from '../../lib/orders.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import {
  openReturnRequest, moveReturnRequest, getReturnRequest, getReturnsForOrder,
  getReturnsForStore, getOpenReturns,
} from '../../lib/return-requests.js';
import type { ReturnReason, ReturnStatus } from '../../lib/returns.js';

/**
 * Every move a return case can make, behind ONE route — and the authorization that decides who may
 * make which.
 *
 * ── The rule this route exists to enforce ──
 * **A case id is not a permission.** Knowing a uuid proves nothing about being allowed to act on it
 * (`checkout-idempotency.ts` carries the version of this the platform learned the hard way, and
 * `store-ownership.ts` the seller-side one). So every branch below re-derives who the caller is from
 * their SESSION and then asks whether that person owns this case:
 *
 *   • the BUYER owns it if the order is theirs — and a guest checkout has no session at all, so a
 *     guest cannot open one here (their route is the seller, per the terms);
 *   • the SELLER owns it if the case's store is one his session says he owns — checked against
 *     `getStoresBySellerId`, never against a slug in the request body;
 *   • the ADMIN may move anything, which is the whole point of the escalation the owner chose.
 *
 * ── Why the transitions are not enumerated per role here ──
 * `returns.ts#canMove` owns the state machine and `return-requests.ts#moveReturnRequest` enforces
 * it. This file decides WHO, that one decides WHETHER. Splitting it the other way — a route that
 * knows both — is how the two get to disagree.
 */

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const REASONS: ReturnReason[] = ['changed_mind', 'damaged', 'wrong_item', 'not_arrived'];

/** Moves a seller may make on his own case. Deliberately excludes 'refunded' from nowhere and
 *  'rejected' from everywhere: the machine decides which are legal FROM the current state, and this
 *  list only says which verbs belong to a seller at all. */
const SELLER_MOVES: ReturnStatus[] = ['approved', 'rejected', 'received', 'disputed', 'refunded'];

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const url = new URL(request.url);

  // The admin's queue — every open case on the platform.
  if (url.searchParams.get('scope') === 'admin') {
    if (!isAdminRequest(cookies)) return json({ error: 'Unauthorized' }, 401);
    return json({ requests: await getOpenReturns() });
  }

  const sellerId = getSellerSession(cookies);
  const storeSlug = url.searchParams.get('store');
  if (sellerId && storeSlug) {
    // Ownership from the SESSION, never from the slug the caller sent.
    const owned = await getStoresBySellerId(sellerId);
    const store = await getStoreBySlugOrPrevious(storeSlug);
    if (!store || !owned.some((s) => s.id === store.id)) return json({ error: 'Forbidden' }, 403);
    return json({ requests: await getReturnsForStore(store.slug) });
  }

  // The buyer's own cases on one order.
  const orderId = url.searchParams.get('order');
  if (orderId) {
    const userId = getSellerSession(cookies);
    if (!userId) return json({ error: 'Unauthorized' }, 401);
    const order = await getOrderById(orderId);
    if (!order || order.buyerId !== userId) return json({ error: 'Forbidden' }, 403);
    return json({ requests: await getReturnsForOrder(orderId) });
  }

  return json({ error: 'Bad request' }, 400);
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!body.ok) return json({ error: 'גוף הבקשה שגוי' }, body.status);
  const data = body.value ?? {};

  // ── A buyer opens a case ──
  if (data.action === 'open') {
    const userId = getSellerSession(cookies);
    if (!userId) return json({ error: 'Unauthorized' }, 401);

    const orderId = String(data.orderId ?? '');
    const order = await getOrderById(orderId);
    // Both halves: the order must exist AND be this buyer's. A guest order has `buyerId`
    // undefined, which no session can equal — so it can never match here by accident.
    if (!order || !order.buyerId || order.buyerId !== userId) return json({ error: 'Forbidden' }, 403);

    const reason = String(data.reason ?? '') as ReturnReason;
    if (!REASONS.includes(reason)) return json({ error: 'סיבה לא מוכרת' }, 400);

    // Only a delivered order can be returned — anything earlier is a CANCELLATION, which is a
    // different flow with a different meaning (decisions §0). Asked of the status directly because
    // this is the one place the distinction is created.
    if (order.shippingStatus !== 'delivered') {
      return json({ error: 'אפשר לבקש החזרה רק על הזמנה שנמסרה' }, 409);
    }

    // The store comes from `storeSubtotals`, which every order has by construction (checkout writes
    // one order per store and one subtotal with it), and falls back to the first line only if that
    // map is somehow empty. Refused outright when neither answers: a request stored with an empty
    // slug is a request nothing can ever move — `getStoreBySlugOrPrevious('')` returns null, so every
    // later approval, receipt and refund 404s, and the case sits open forever freezing the seller's
    // money on an order nobody can act on. Failing at creation is the recoverable version.
    const slug = Object.keys(order.storeSubtotals ?? {})[0] ?? order.items[0]?.storeSlug ?? '';
    if (!slug) return json({ error: 'לא ניתן לזהות את החנות של ההזמנה' }, 409);

    const result = await openReturnRequest({
      order, storeSlug: slug, reason,
      buyerNote: String(data.note ?? '').slice(0, 2000),
    });
    if ('error' in result) return json({ error: result.error }, 409);
    return json({ request: result }, 201);
  }

  // ── Everyone else moves an existing case ──
  const id = String(data.id ?? '');
  const to = String(data.to ?? '') as ReturnStatus;
  const existing = await getReturnRequest(id);
  if (!existing) return json({ error: 'בקשת ההחזרה לא נמצאה' }, 404);

  const store = await getStoreBySlugOrPrevious(existing.storeSlug);
  if (!store) return json({ error: 'החנות לא נמצאה' }, 404);

  const admin = isAdminRequest(cookies);
  let actor = 'admin';

  if (!admin) {
    const sellerId = getSellerSession(cookies);
    if (!sellerId) return json({ error: 'Unauthorized' }, 401);
    const owned = await getStoresBySellerId(sellerId);
    if (!owned.some((s) => s.id === store.id)) return json({ error: 'Forbidden' }, 403);
    if (!SELLER_MOVES.includes(to)) return json({ error: 'הפעולה הזאת אינה של המוכר' }, 403);
    // Belt and braces: the case names a store, and the order must really belong to it. A case row
    // whose slug drifted from its order would otherwise let the wrong seller act.
    const order = await getOrderById(existing.orderId);
    if (!order || !orderBelongsToStore(order, store.slug)) return json({ error: 'Forbidden' }, 403);
    actor = sellerId;
  }

  const moved = await moveReturnRequest({
    id, to, actor,
    store: { slug: store.slug, name: store.name, sellerId: store.sellerId },
    trackingNumber: typeof data.trackingNumber === 'string' ? data.trackingNumber.slice(0, 120) : undefined,
    sellerNote: typeof data.sellerNote === 'string' ? data.sellerNote.slice(0, 2000) : undefined,
    adminNote: admin && typeof data.adminNote === 'string' ? data.adminNote.slice(0, 2000) : undefined,
    partialOfferAgorot: typeof data.partialOfferAgorot === 'number' && data.partialOfferAgorot > 0
      ? Math.round(data.partialOfferAgorot) : undefined,
  });
  if ('error' in moved) return json({ error: moved.error }, 409);
  return json({ request: moved.request });
}
