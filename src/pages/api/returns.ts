export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { isAdminRequest } from '../../lib/admin-auth.js';
import { getStoresBySellerId, getStoreBySlugOrPrevious } from '../../lib/stores.js';
import { getOrderById, updateOrder, orderBelongsToStore } from '../../lib/orders.js';
import { settleStatusChange } from '../../lib/order-status-change.js';
import { notifySellerOrderCancelled } from '../../lib/order-notify.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { sanitizeImageUrl } from '../../lib/image-url.js';
import {
  openReturnRequest, moveReturnRequest, getReturnRequest, getReturnsForOrder,
  getReturnsForStore, getOpenReturns,
} from '../../lib/return-requests.js';
import { buyerActionFor, RETURN_NOTE_MAX, type ReturnedLine, type ReturnReason, type ReturnStatus } from '../../lib/returns.js';
import { returnableLinePositions } from '../../lib/return-eligibility-order.js';
import { resolveOrderAccess } from '../../lib/order-access.js';
import { clientIp } from '../../lib/client-ip.js';
import { checkAuthRate, countAuthAttempt, orderHelpRules, retryAfterMinutes } from '../../lib/rate-limit.js';

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

export async function POST({ request, cookies, clientAddress }: APIContext): Promise<Response> {
  const body = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!body.ok) return json({ error: 'גוף הבקשה שגוי' }, body.status);
  const data = body.value ?? {};

  // ── A buyer opens a case ──
  if (data.action === 'open') {
    // **Who the caller is, and which order is theirs — one function, three credentials**
    // (`order-access.ts`): a session, a signed link mailed to the buyer, or the order number plus
    // the address it was placed with. A GUEST reaches this branch through the last two, which is
    // the whole reason the resolver exists: a case is filed against an ORDER, and guest checkout is
    // the default here, so requiring an account meant most buyers could not open one at all
    // (owner, 2026-08-17). Nothing BELOW this line changed — what may be done, and to which lines,
    // is the same code for everybody.
    //
    // The two credentials a guest can present are guessable in principle, so they are rate-limited
    // on the way in. A signed-in buyer's session is not, and is not counted.
    const rules = orderHelpRules(clientIp(request, clientAddress));
    const guestAttempt = !getSellerSession(cookies);
    if (guestAttempt) {
      const gate = await checkAuthRate(rules);
      if (!gate.allowed) {
        return json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות', retryAfterMinutes: retryAfterMinutes(gate.retryAfterSec) }, 429);
      }
      await countAuthAttempt(rules);
    }

    const access = await resolveOrderAccess(data, cookies);
    // ONE answer for "no such order", "wrong email" and "not yours". Three would make this an
    // oracle for which order numbers exist, which an 8-character reference cannot afford.
    if (!access) return json({ error: 'Forbidden' }, 403);
    const { order, buyerId } = access;

    const reason = String(data.reason ?? '') as ReturnReason;
    if (!REASONS.includes(reason)) return json({ error: 'סיבה לא מוכרת' }, 400);

    // ── Which of the buyer's two rights is this? ──
    //
    // Decisions §1 gives them both, and the first build of this route implemented only the second:
    // it refused everything that was not `delivered`, which is right for a RETURN and deleted the
    // CANCELLATION entirely. `buyerActionFor` is now the single answer, shared with the screen, so
    // the button and the endpoint cannot disagree about what is offered.
    const action = buyerActionFor(order);
    if (action === 'none') {
      return json({ error: 'לא ניתן לבטל או להחזיר את ההזמנה הזאת' }, 409);
    }

    // ── Cancel: nothing left, so nothing comes back ──
    //
    // No request row, no clocks, no seller discretion — decisions §1 says immediate and automatic.
    // It goes through `settleStatusChange` like every other cancellation, which is what restocks the
    // units, writes the journal row, opens the refund obligation and tells the seller. Writing any
    // of that here would be a second definition of what a cancellation costs.
    if (action === 'cancel') {
      const slug = Object.keys(order.storeSubtotals ?? {})[0] ?? order.items[0]?.storeSlug ?? '';
      const store = slug ? await getStoreBySlugOrPrevious(slug) : null;
      if (!store) return json({ error: 'לא ניתן לזהות את החנות של ההזמנה' }, 409);

      const after = await updateOrder(order.id, { shippingStatus: 'cancelled' });
      if (!after) return json({ error: 'הביטול לא בוצע' }, 409);
      await settleStatusChange({
        before: order, after,
        store: { slug: store.slug, name: store.name, sellerId: store.sellerId },
        // `buyerId` and not a session id — a guest cancelling their own order is still the buyer,
        // and the journal should say so rather than name nobody.
        actor: buyerId ?? 'buyer',
        detail: 'בוטלה על ידי הקונה לפני שיצאה למשלוח',
      });
      // The seller has to be told, and by NOTIFICATION rather than mail: he had not packed anything,
      // the stock is already back, and the order is still in his list under "בוטלה". A mail per
      // cancellation is how a person learns to filter the sender (owner, 2026-08-16).
      await notifySellerOrderCancelled(store.sellerId, order, store.slug);
      return json({ cancelled: true }, 200);
    }

    // The store comes from `storeSubtotals`, which every order has by construction (checkout writes
    // one order per store and one subtotal with it), and falls back to the first line only if that
    // map is somehow empty. Refused outright when neither answers: a request stored with an empty
    // slug is a request nothing can ever move — `getStoreBySlugOrPrevious('')` returns null, so every
    // later approval, receipt and refund 404s, and the case sits open forever freezing the seller's
    // money on an order nobody can act on. Failing at creation is the recoverable version.
    const slug = Object.keys(order.storeSubtotals ?? {})[0] ?? order.items[0]?.storeSlug ?? '';
    if (!slug) return json({ error: 'לא ניתן לזהות את החנות של ההזמנה' }, 409);

    // The store is resolved here anyway, so the seller's id travels with the request and the
    // notification cannot be silently skipped for want of it.
    // ── Which lines, if this is a partial return ──
    //
    // Validated here and clamped again in `partialRefundAgorot`: this list arrives in a request body,
    // so a position pointing at no line, a negative quantity or one larger than was bought must cost
    // the seller nothing. A body naming no valid line at all falls through to a whole-order return,
    // which is what the buyer's default button means anyway.
    const asked = Array.isArray(data.lines) ? data.lines : [];
    const returnedLinesRaw: ReturnedLine[] = asked
      .map((raw) => {
        const l = raw as { position?: unknown; qty?: unknown };
        const position = Math.floor(Number(l.position));
        const qty = Math.floor(Number(l.qty));
        return { position, qty };
      })
      .filter((l) => Number.isInteger(l.position) && l.position >= 0 && l.position < order.items.length
        && Number.isInteger(l.qty) && l.qty > 0 && l.qty <= (order.items[l.position]?.qty ?? 0))
      // …and only lines the regulations allow back. A body naming an excluded shelf is refused
      // below rather than silently trimmed: a buyer who ticked three items and is refunded for two
      // has been told nothing about the third.
      .filter((l) => !allowedPositions || allowedPositions.has(l.position));

    if (asked.length > 0 && returnedLinesRaw.length === 0) {
      return json({ error: 'לפי תקנות הגנת הצרכן, הפריטים שבחרת לא ניתנים להחזרה' }, 409);
    }

    // Naming every line at full quantity IS the whole order — stored as such so the settlement takes
    // the status path rather than the adjustment one, and the two never disagree about the same act.
    const returnedLines = returnedLinesRaw;
    const wholeOrder = returnedLines.length === order.items.length
      && returnedLines.every((l) => l.qty === order.items[l.position]!.qty);

    const store = await getStoreBySlugOrPrevious(slug);

    // The law's own exclusions, per PRODUCT (`return-eligibility-order.ts`). Enforced on the SERVER
    // even though the buyer's screen already withholds the line — a hidden checkbox is not a rule,
    // and this endpoint is directly callable.
    //
    // A CANCELLATION never reaches here: nothing was supplied yet, so there is nothing for the
    // exclusion to be about. It is the return the regulation removes, not the right to stop an
    // order that has not left.
    const allowedPositions = store ? await returnableLinePositions(order, store.id) : null;
    if (allowedPositions && allowedPositions.size === 0) {
      return json({ error: 'לפי תקנות הגנת הצרכן, המוצרים בהזמנה הזאת לא ניתנים להחזרה' }, 409);
    }

    const result = await openReturnRequest({
      order, storeSlug: slug, reason,
      // Capped at the field's own limit, not at some larger number here: the two would drift, and
      // the bigger one silently wins for anything posted straight at the endpoint.
      buyerNote: String(data.note ?? '').slice(0, RETURN_NOTE_MAX),
      // Through `sanitizeImageUrl`, never straight out of the body: it validates by SHAPE and stores
      // the URL parser's own serialisation, so quotes and angle brackets come back percent-encoded
      // and an attribute breakout is impossible even where a screen forgets to escape
      // (`lib/image-url.ts`, and `tests/image-url.test.ts` greps for exactly this).
      buyerPhotoUrl: sanitizeImageUrl(data.photoUrl),
      returnedLines: wholeOrder ? null : returnedLines,
      ...(store ? { sellerId: store.sellerId, storeName: store.name } : {}),
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

  // What an offer may not exceed — the order's own total. Read once for both branches below.
  const targetOrder = await getOrderById(existing.orderId);
  const offerCeilingAgorot = targetOrder?.totalAgorot ?? 0;

  const admin = isAdminRequest(cookies);
  let actor = 'admin';

  // ── The buyer answering an offer ──
  //
  // The only move that belongs to the buyer, and it exists because the offer was a QUESTION: accept
  // and keep the goods for a smaller refund, or decline and the ordinary return resumes where it
  // stopped. Checked before the seller branch, because a buyer is not a seller and would otherwise
  // fall through to a 403 on their own order.
  if (!admin && existing.status === 'offered' && (to === 'refunded' || to === 'approved')) {
    // Through the SAME resolver the open branch uses (`order-access.ts`), and for the same reason:
    // a guest can now open a case, so a guest can be sent an offer — and an offer they cannot
    // answer is the dead end this whole change exists to remove. The offer mail carries the signed
    // link; the order number and the buying address work here too.
    const access = await resolveOrderAccess({ ...data, orderId: existing.orderId }, cookies);
    if (access) {
      const answered = await moveReturnRequest({
        id, to, actor: access.buyerId ?? 'buyer',
        store: { slug: store.slug, name: store.name, sellerId: store.sellerId },
      });
      if ('error' in answered) return json({ error: answered.error }, 409);
      return json({ request: answered.request });
    }
  }

  if (!admin) {
    const sellerId = getSellerSession(cookies);
    if (!sellerId) return json({ error: 'Unauthorized' }, 401);
    const owned = await getStoresBySellerId(sellerId);
    if (!owned.some((s) => s.id === store.id)) return json({ error: 'Forbidden' }, 403);
    if (!SELLER_MOVES.includes(to)) return json({ error: 'הפעולה הזאת אינה של המוכר' }, 403);
    // An offer is a QUESTION put to the buyer, so only the buyer (or an admin) may answer it. Without
    // this a seller could accept his own offer and force a partial refund in place of the full return
    // the buyer is entitled to — the machine allows the transition, and only the ROLE forbids it.
    if (existing.status === 'offered') {
      return json({ error: 'רק הקונה יכול לענות על ההצעה' }, 403);
    }
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
    // Capped at what the buyer actually paid: an offer is an alternative to refunding the order, so
    // it can never exceed it. Unbounded, this writes a debt bigger than the sale and a ledger row to
    // match — and both are real money on a screen somebody acts on.
    partialOfferAgorot: typeof data.partialOfferAgorot === 'number'
      && Number.isFinite(data.partialOfferAgorot) && data.partialOfferAgorot > 0
      ? Math.min(Math.round(data.partialOfferAgorot), offerCeilingAgorot) : undefined,
  });
  if ('error' in moved) return json({ error: moved.error }, 409);
  return json({ request: moved.request });
}
