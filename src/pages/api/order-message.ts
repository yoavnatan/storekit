export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { clientIp } from '../../lib/client-ip.js';
import { checkAuthRate, countAuthAttempt, orderHelpRules, retryAfterMinutes } from '../../lib/rate-limit.js';
import { resolveOrderAccess, isGuessedCredential } from '../../lib/order-access.js';
import { getStoreBySlugOrPrevious } from '../../lib/stores.js';
import { createMessage, GUEST_SENDER_PREFIX, MAX_MESSAGE_CONTENT_LEN } from '../../lib/messages.js';
import { createNotification } from '../../lib/notifications.js';
import { NOTIFY_NEW_MESSAGE_FROM_BUYER } from '../../lib/notification-copy.js';
import { checkMessageFlood, countMessageSent, floodRefusal, newThreadRules } from '../../lib/message-flood.js';
import { withTransaction } from '../../lib/db.js';

/**
 * "שאלה למוכר" — a buyer asking about an order, without an account.
 *
 * ── The gap this closes (owner, 2026-08-19) ──
 * `/contact` told buyers the seller is the first address and pointed at the "צור קשר עם החנות"
 * button on the store page. That button requires a session — and guest checkout is the DEFAULT
 * here, so for most buyers the advice was a closed circle. The only thing a guest could actually do
 * with their own order was open a RETURN CASE, which is a heavy instrument for "when is this
 * shipping?" and leaves a record against the seller that nobody wanted.
 *
 * So the signed order link now carries both: a return request, and a plain question that lands in
 * the seller's inbox with the order beside it.
 *
 * ── Authentication is `order-access.ts`, not a session, and nothing here re-implements it ──
 * The same three credentials the returns endpoint accepts — a session that owns the row, the signed
 * `help` link, or the order number plus the address it was placed with — with the same single
 * failure answer. Distinguishing "no such order" from "wrong email" would make this an oracle for
 * which of the 8-character references exist, and this endpoint would be a second place for that
 * mistake to be made.
 *
 * ── What it may do is deliberately narrow ──
 * One message, to the seller of THAT order's store, with the order's reference in the subject. It
 * cannot choose a recipient: the store comes from the order. A guest who could name the store would
 * have a way to message any seller on the platform without an account.
 */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, cookies, clientAddress }) => {
  const read = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: 'Invalid body' }, read.status);
  const data = read.value;

  const content = String(data.content ?? '').trim();
  if (!content || content.length > MAX_MESSAGE_CONTENT_LEN) return json({ error: 'הודעה ריקה או ארוכה מדי' }, 400);

  // The order number plus the buying address is a guessable credential, so it is rate-limited on the
  // way in — the same bucket `/api/returns` uses, because it is the same guess. Gated on the
  // CREDENTIAL and not on the session: `order-access.ts#isGuessedCredential` carries why.
  const rules = orderHelpRules(clientIp(request, clientAddress));
  if (isGuessedCredential(data)) {
    const gate = await checkAuthRate(rules);
    if (!gate.allowed) {
      return json({ error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות', retryAfterMinutes: retryAfterMinutes(gate.retryAfterSec) }, 429);
    }
    await countAuthAttempt(rules);
  }

  const access = await resolveOrderAccess(data, cookies);
  // ONE answer for "no such order", "wrong email" and "not yours" — see the header.
  if (!access) return json({ error: 'Forbidden' }, 403);
  const { order, buyerId } = access;

  // The store is taken from the ORDER, never from the request. `getStoreBySlugOrPrevious` because a
  // store that has since renamed its URL is still the store this purchase was made from.
  const storeSlug = order.items[0]?.storeSlug ?? '';
  const store = storeSlug ? await getStoreBySlugOrPrevious(storeSlug) : null;
  if (!store) return json({ error: 'Forbidden' }, 403);

  // The same ceiling a signed-in buyer's first message meets. Without it this is an unlimited write
  // path beside a limited one, which is the shape a limiter is routed around — the identical
  // reasoning `api/admin-messages.ts` records for the seller's side of a system thread.
  //
  // Measured over this ORDER's existing thread, not over an account: a guest has no account to
  // measure, and the order is what both sides of this conversation actually share.
  const floodKey = buyerId || `${GUEST_SENDER_PREFIX}${order.id}`;
  const floodRules = newThreadRules(floodKey, store.id);
  const verdict = await checkMessageFlood(floodRules, [], floodKey);
  if (!verdict.allowed) return floodRefusal(verdict, cookies);

  await withTransaction(async (tx) => {
    const message = await createMessage({
      // A guest id is not an account id, and the column is plain `text` precisely so it can say so
      // (messages.ts). `order:<id>` keeps the thread attributable without inventing an account.
      fromUserId: floodKey,
      fromName: order.buyerName,
      fromEmail: order.buyerEmail,
      toStoreId: store.id,
      toSellerId: store.sellerId,
      toStoreName: store.name,
      subject: `שאלה על הזמנה ${order.checkoutRef ?? order.id.slice(0, 8).toUpperCase()}`,
      content,
      readByBuyer: true,
    }, tx);
    await createNotification({
      userId: store.sellerId,
      role: 'seller',
      type: 'new_message',
      title: NOTIFY_NEW_MESSAGE_FROM_BUYER,
      body: content.slice(0, 120),
      relatedId: message.id,
    }, tx);
  });
  await countMessageSent(floodRules);

  return json({ ok: true });
};
