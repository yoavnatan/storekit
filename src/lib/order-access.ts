import type { AstroCookies } from 'astro';
import { getSellerSession } from './seller-auth.js';
import { getOrderById, getOrderByRef, type Order } from './orders.js';
import { verifyOrderToken } from './order-token.js';

/**
 * Which order may this caller act on — the ONE answer, for a buyer with an account and a buyer
 * without one.
 *
 * ── Why this exists at all (owner, 2026-08-17) ──
 * `/api/returns` required a session, so a GUEST could not open a case about their own order — not a
 * return, not a cancellation, not "it never arrived". Guest checkout is the default here, so that
 * was most buyers, and their only remaining route was a generic contact form that did not know
 * which order they meant. The owner's reading is the correct one and it is also the schema's: a
 * case is filed against an ORDER (`return_requests.order_id`), never against an account. The
 * account was only ever the way we recognised the person.
 *
 * ── So this changes the AUTHENTICATION and nothing else ──
 * Everything about what may then be done — cancel versus return, which lines the consumer
 * regulations allow back, one open case per order, who pays return postage — stays exactly where it
 * is, in `/api/returns` and `returns.ts`. Re-implementing any of it for guests would be a second
 * definition of what opening a case means, on the surface where that costs money.
 *
 * ── The three credentials, and why each is enough ──
 *
 *   1. **Session + order id.** The rule as it was: the order's `buyerId` must be this account. A
 *      guest order has no `buyerId`, which no session can equal, so it can never match by accident.
 *
 *   2. **Signed link.** `order-token.ts`, purpose `help`, mailed to the address that placed the
 *      order. Strictly stronger than anything typed, and the buyer types nothing.
 *
 *   3. **Order number + the email it was placed with.** For the buyer who deleted the mail. Both,
 *      always: the reference is 8 random hex characters (~4.3 billion, not sequential — see
 *      `checkout.ts`), so it is not walkable, and pairing it with the address makes guessing two
 *      unrelated secrets at once. `checkAuthRate` bounds the attempts on top.
 *
 * ── One failure, never three ──
 * Every miss returns `null` and every caller answers the same way. Distinguishing "no such order"
 * from "wrong email" turns this into an oracle for which order numbers exist, which is precisely
 * what an 8-character reference cannot afford.
 */

export interface OrderCredential {
  /** Order id (session or signed-link routes). */
  orderId?: unknown;
  /** Signed `help` token from a mailed link. */
  token?: unknown;
  /** The human order number printed on the confirmation — `checkoutRef`. */
  orderRef?: unknown;
  /** The address the order was placed with. */
  email?: unknown;
}

/** How the caller proved it, for the audit line on whatever gets written. Never returned to a
 *  client: it would tell a guesser which half of their attempt landed. */
export type OrderProof = 'session' | 'token' | 'ref-email';

export interface OrderAccess {
  order: Order;
  proof: OrderProof;
  /** The account behind it, when there is one. `null` for a guest — what `openReturnRequest`
   *  records as the actor, and what keeps a guest case indistinguishable from any other. */
  buyerId: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function resolveOrderAccess(
  credential: OrderCredential,
  cookies: AstroCookies,
): Promise<OrderAccess | null> {
  const orderId = str(credential.orderId);
  const userId = getSellerSession(cookies);

  // 1 — a session that owns the row. Checked FIRST so a signed-in buyer never depends on a mail.
  if (orderId && userId) {
    const order = await getOrderById(orderId);
    if (order && order.buyerId && order.buyerId === userId) {
      return { order, proof: 'session', buyerId: userId };
    }
  }

  // 2 — the mailed link.
  if (orderId && verifyOrderToken(orderId, 'help', credential.token)) {
    const order = await getOrderById(orderId);
    // `buyerId` is carried through even here: a registered buyer who happens to arrive by mail is
    // still that account, and the case should read as theirs.
    if (order) return { order, proof: 'token', buyerId: order.buyerId ?? null };
  }

  // 3 — the order number and the address it was placed with.
  const ref = str(credential.orderRef).toUpperCase();
  const email = str(credential.email).toLowerCase();
  if (ref && email) {
    const order = await getOrderByRef(ref);
    // `buyer_email` is `citext`, so the database already compares it case-insensitively; lowering
    // here as well costs nothing and keeps the comparison honest if that column ever changes type.
    if (order && order.buyerEmail.toLowerCase() === email) {
      return { order, proof: 'ref-email', buyerId: order.buyerId ?? null };
    }
  }

  return null;
}

/**
 * Is this request presenting a GUESSABLE credential — the order number plus the address it was
 * placed with?
 *
 * **The three callers gated on `!getSellerSession(cookies)`, and that was the wrong question**
 * (found 2026-08-19, while reviewing a fourth endpoint written the same way). It reads as "an
 * anonymous request is a guess and a signed-in one is not", which is true of the SESSION branch —
 * that one requires the order's `buyerId` to equal the account, so there is nothing to guess. But
 * this is one function with three doors, and the ref+email door stays open to a signed-in caller:
 * registration here is free and instant, so "sign in first" removed the limiter entirely for
 * anyone who bothered to. An 8-character reference plus the buying address is two secrets and not
 * walkable, which is why this was a weakness rather than a break — but the limiter exists precisely
 * so that nothing rests on that arithmetic staying true.
 *
 * So the gate follows the CREDENTIAL, not the session. A signed-in buyer acting on their own order
 * presents `orderId` alone and is never counted; anyone presenting a reference and an address is
 * counted, session or not.
 *
 * `tests/order-access-throttle.test.ts` scans every caller of `resolveOrderAccess` and fails on one
 * that does not run this, so the next endpoint cannot quietly re-derive the old predicate.
 */
export function isGuessedCredential(credential: OrderCredential): boolean {
  return !!(str(credential.orderRef) && str(credential.email));
}
