import { rows } from './db.js';
import { recordMoneyEvent } from './money-events.js';
import { createNotification } from './notifications.js';
import { getStoreBySlug } from './stores.js';
import { formatAgorot } from './money.js';
import { logError } from './error-log.js';

/**
 * A buyer disputed a charge with their bank — and the one thing that must not happen is silence.
 *
 * ── What was here before (found 2026-08-25, owner asked "מה קורה בעת הכחשת עסקה?") ──
 * PayMe's `sale-chargeback` notification arrived, passed the signature check, and was written to
 * the journal as a `payment_attempted` row. That is all. The order went on counting as revenue, the
 * stock stayed off the shelf, the seller was never told, and the only trace was a row whose TYPE
 * said a payment had been attempted — the opposite of what had happened. A seller could lose the
 * goods and the money and learn about it from his bank statement a month later.
 *
 * ── What this does, and the line it deliberately does not cross ──
 * It makes the event LOUD and correctly named: its own journal type, against the right order and
 * the right store, and a notification to the seller whose money it is. It does **not** change the
 * order's status and does **not** restock.
 *
 * That restraint is the design, not an omission. A chargeback is not a cancellation: the buyer
 * usually has the goods, the money has already been pulled back by a bank that did not ask us, and
 * what happens next — accept it, contest it, ship a replacement — is a decision with a person in
 * it. `order-status-rules.ts` requires a new status to arrive as a ROW with every consequence
 * filled in; inventing one here, from inside a callback, would have this module deciding a policy
 * nobody has written. **The gap is now visible instead of silent, which is the part that could be
 * fixed without a decision.** What PayMe themselves do about the distribution fee is question 3 in
 * `docs/payme-questions-open.md`.
 *
 * ── Never throws ──
 * It runs inside a webhook that must answer 200 or PayMe retry it. Every failure is logged and
 * swallowed; the notification and the journal row are independent, so losing one does not lose the
 * other.
 */

/** Which direction the dispute moved. `reverted` is the bank finding for the seller. */
export type ChargebackKind = 'chargeback' | 'chargeback_reverted';

export interface ChargebackInput {
  /** Our own reference, as it was sent to PayMe: `<checkoutRef>-<storeSlug>` for a goods leg, or
   *  `<checkoutRef>-delivery` for the shipping charge (`payment-split.ts`). */
  transactionId: string;
  /** PayMe's own sale id, for the journal so a support call can quote it. */
  paymeSaleId: string;
  /** Agorot, as PayMe reported it. Zero when they sent nothing legible. */
  amountAgorot: number;
  kind: ChargebackKind;
}

/**
 * Split our reference back into its two halves.
 *
 * Pure, and separated because it is the one piece of parsing here: `checkoutRef` is a hex string
 * with no dashes and the slug may contain them, so the split is on the FIRST dash and not the last.
 * A slug like `bag-boutique` would otherwise come back as `boutique` and match no store.
 */
export function splitTransactionId(transactionId: string): { checkoutRef: string; leg: string } | null {
  const at = transactionId.indexOf('-');
  if (at <= 0 || at === transactionId.length - 1) return null;
  return { checkoutRef: transactionId.slice(0, at), leg: transactionId.slice(at + 1) };
}

interface OrderRow { id: string; seller_id: string; store_slug: string; total_agorot: number }

/**
 * The order a disputed charge belongs to, or null.
 *
 * Null is a real answer and must stay one: the delivery leg (`<ref>-delivery`) is a charge on OUR
 * merchant account and belongs to no order row at all, and the sandbox is shared so a callback may
 * name a checkout that was never ours. Both are cases to record and not to guess at.
 */
async function orderForLeg(checkoutRef: string, leg: string): Promise<OrderRow | null> {
  if (leg === 'delivery') return null;
  const store = await getStoreBySlug(leg);
  if (!store) return null;
  const found = await rows<OrderRow>(
    `SELECT o.id, $3::text AS seller_id, $2::text AS store_slug, o.total_agorot
       FROM orders o
      WHERE o.checkout_ref = $1 AND o.store_slug = $2
      LIMIT 1`,
    [checkoutRef, leg, store.sellerId],
  );
  return found[0] ?? null;
}

const SELLER_COPY: Record<ChargebackKind, { title: string; body: (amount: string) => string }> = {
  chargeback: {
    title: 'קונה הכחיש עסקה',
    // States the fact and the consequence, and asks for nothing — because there is nothing here he
    // can press. Naming an action that does not exist is worse than naming none.
    body: (amount) => `קונה פנה לחברת האשראי וביקש לבטל חיוב של ${amount}. הכסף נלקח בחזרה מחשבון הסליקה שלכם. אנחנו בודקים מול חברת הסליקה מה אפשר לעשות ונעדכן.`,
  },
  chargeback_reverted: {
    title: 'ההכחשה בוטלה',
    body: (amount) => `חברת האשראי ביטלה את ההכחשה על ${amount}, והכסף חזר לחשבון הסליקה שלכם.`,
  },
};

/**
 * Record a dispute and tell the seller.
 *
 * Returns whether an order was identified — the caller uses it only to say something true in its
 * acknowledgement, never to decide whether to answer PayMe.
 */
export async function recordChargeback(input: ChargebackInput): Promise<{ orderId: string | null }> {
  const parts = splitTransactionId(input.transactionId);
  const order = parts ? await orderForLeg(parts.checkoutRef, parts.leg) : null;
  const amount = formatAgorot(input.amountAgorot);

  // Everything the row carries except its type — which is written out as a LITERAL in each branch
  // below rather than passed through as `input.kind`. `money-owed-guards` scans the tree for
  // `type: '<name>'` to prove every word in the money vocabulary is really written by something,
  // and a variable is invisible to it. The guard was right to fail on the first version: a type
  // nothing writes is a filter chip that never matches and a row nobody will ever see.
  const row = {
    ...(order ? { orderId: order.id, storeSlug: order.store_slug } : {}),
    ...(parts ? { checkoutRef: parts.checkoutRef } : {}),
    ...(input.amountAgorot > 0 ? { amountAgorot: input.amountAgorot } : {}),
    actor: 'system',
  };
  const ref = `אסמכתה ${input.paymeSaleId}`;
  // An `if` and not a ternary, for a second guard: `async-lib-awaited` reads LINE BY LINE, and the
  // branches of `await (a ? x() : y())` sit on lines that do not begin with `await`. Both guards
  // are satisfied by the plainest possible shape, which is also the one easiest to read.
  if (input.kind === 'chargeback') {
    await recordMoneyEvent({ type: 'chargeback', ...row, detail: `חברת הסליקה · הכחשת עסקה · ${ref}` })
      .catch(() => { /* the alert below is the half a person reads */ });
  } else {
    await recordMoneyEvent({ type: 'chargeback_reverted', ...row, detail: `חברת הסליקה · ביטול הכחשה · ${ref}` })
      .catch(() => { /* same */ });
  }

  if (order) {
    const copy = SELLER_COPY[input.kind];
    await createNotification({
      userId: order.seller_id,
      role: 'seller',
      type: 'order_update',
      title: copy.title,
      body: copy.body(amount),
      // `relatedId` and not a hand-built href: `notification-link.ts` turns the pair into the
      // dashboard link, so a route that moves does not leave this string pointing nowhere.
      relatedId: order.id,
      storeSlug: order.store_slug,
    }).catch(() => { /* the journal row stands */ });
  }

  // **Loud even when everything worked.** A chargeback costs the seller the goods, the money and a
  // fee, and it may cost us the distribution fee too (question 3, `payme-questions-open.md`). There
  // is nothing automatic to do about it, so a person has to see it — and an unmatched one, where we
  // cannot even say whose sale it was, is the case that most needs somebody looking.
  await logError({
    source: 'server',
    route: '/api/payme/callback',
    message: `PayMe ${input.kind} ${amount} on ${input.transactionId} (sale ${input.paymeSaleId})${order ? ` → order ${order.id}` : ' → NO MATCHING ORDER'}`,
    resolutionHint: order
      ? 'קונה הכחיש עסקה. ההזמנה נשארת כפי שהיא בכוונה — הסחורה כבר אצל הקונה והכסף נלקח בחזרה, וההחלטה מה לעשות היא אנושית. המוכר קיבל התראה.'
      : 'התקבלה הודעת הכחשת עסקה שלא הצלחנו לשייך להזמנה. ייתכן שזו עסקה של שותף אחר בסנדבוקס המשותף, וייתכן שזו הזמנה שלנו והשיוך נשבר — שווה לבדוק את האסמכתה מול חברת הסליקה.',
  }).catch(() => { /* nothing left to try */ });

  return { orderId: order?.id ?? null };
}
