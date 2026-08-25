import { recordMoneyEvent } from './money-events.js';
import { orderCountsAsRevenue, orderMoneyWasTaken } from './order-status-rules.js';
import type { Order } from './orders.js';

/**
 * When a status change leaves the buyer owed money back — and the entry that says so.
 *
 * **The gap this closes.** A seller cancelling an order they had already been paid for produced one
 * journal row: `shipping_status_changed → cancelled`. That is a FULFILMENT fact. It correctly took
 * the order out of every revenue sum and out of the seller's balance, and it correctly told the
 * buyer their order was cancelled — and the money, which had really been captured off a real card,
 * simply stayed where it was. No screen named it, no total counted it, and the only way to find one
 * was to read the journal and know what the row implied. "The money and what a seller or buyer SEES
 * disagree" is the whole class of bug this area was audited for, and this was the largest instance
 * of it in the tree.
 *
 * **What the rule is, and what it deliberately is not.** Money is owed back when an order whose
 * payment was CAPTURED stops counting as revenue. Not "when it is cancelled" — a status is a row in
 * `order-status-rules.ts`, and a future `returned` or `refused` must inherit this answer by filling
 * that row in, never by someone remembering this file exists. And not "when it is unpaid": an order
 * whose capture failed was never charged, so `failCapture` in the checkout owes nothing and writes
 * nothing here.
 *
 * **Why the obligation and the settlement are two events.** `refund_due` is written the moment the
 * debt exists, by the code that creates it. `refund_settled` is written when the money has actually
 * gone back. They stay two events now that both really happen, and the separation is what makes a
 * FAILED refund visible: `reconcile.ts` pairs them off and reports every obligation with no
 * settlement against it, so a gateway refusal is an open row somebody can see rather than a debt
 * the record closed on its own.
 *
 * **`refund-execute.ts` is the other half, and it exists** — since 2026-08-23, against PayMe. This
 * header said "no provider is chosen yet" for two months after that stopped being true, and
 * `HOW_IT_WORKS.md` repeated it; both were corrected on 2026-08-25. Nothing in THIS file performs a
 * refund and nothing here should: it decides whether one is owed and how much, which is a rule over
 * statuses, and the gateway call is a different job with different failure modes.
 */

/** The amount the buyer is owed if this order stops counting — the whole slice, goods and shipping
 *  alike, because that is what left their card. Not `orderNetForStore`, which is the SELLER's share
 *  and is a different question with a different answer. */
export function refundOwedAgorot(order: Pick<Order, 'totalAgorot'>): number {
  return order.totalAgorot;
}

/**
 * Did this status move turn a captured payment into money owed back?
 *
 * Pure, and asked of both halves rather than of the word "cancelled": the payment must have been
 * captured (`paid`), and the order must have counted as revenue BEFORE and not AFTER.
 */
export function createsRefundObligation(
  before: Pick<Order, 'paymentStatus' | 'shippingStatus'>,
  after: Pick<Order, 'paymentStatus' | 'shippingStatus'>,
): boolean {
  // Asked of the status table, never of the word 'paid' — a payment status is a row with a column
  // per consequence, and `moneyWasTaken` is the column this rule needs (order-status-rules.ts).
  if (!orderMoneyWasTaken(after)) return false;
  return orderCountsAsRevenue(before) && !orderCountsAsRevenue(after);
}

/**
 * Record the obligation, if this move created one. Returns the amount owed, or 0.
 *
 * Never throws — it is a journal write, and the rule the journal lives under is that failing to
 * record an event must not fail the operation being recorded (money-events.ts).
 */
export async function recordRefundOwed(
  before: Pick<Order, 'paymentStatus' | 'shippingStatus'>,
  after: Order,
  storeSlug: string,
  actor: string,
): Promise<number> {
  if (!createsRefundObligation(before, after)) return 0;
  const amountAgorot = refundOwedAgorot(after);
  await recordMoneyEvent({
    type: 'refund_due',
    orderId: after.id,
    checkoutRef: after.checkoutRef,
    storeSlug,
    amountAgorot,
    from: before.shippingStatus,
    to: after.shippingStatus,
    actor,
    // Written for whoever reads the journal months later, which is the only audience it has — and
    // that audience reads Hebrew. It said all of this in English until 2026-08-16, on a screen whose
    // every other column is Hebrew, which is how the row that names real money owed to a real person
    // became the least readable row on it.
    //
    // The status itself is deliberately NOT spelled out in words here. The row already carries it
    // in its own `from`/`to` columns, which the panel renders beside this text — and a Hebrew word
    // per status written at this call site would be a second copy of a vocabulary that belongs to
    // `order-status-rules.ts`, drifting the first time a `returned` status is added.
    detail: `הכסף נגבה בפועל (אסמכתה ${after.paymentRef ?? '—'}) וההזמנה יצאה מהמכירות. הסכום הזה מגיע בחזרה לקונה, ועדיין לא הוחזר.`,
  });
  return amountAgorot;
}

/**
 * The same obligation, for an order that got CHEAPER without leaving the sales.
 *
 * **The gap this closes, and it is the twin of the one at the top of this file.** A seller can edit
 * a paid order from their own screen: delete a line they cannot fulfil, override the shipping, or
 * give a discount as a goodwill gesture instead of taking the whole thing back. Every one of those
 * lowers the total on an order the buyer has ALREADY paid in full — and until now the only thing
 * recorded was `order_discount_changed`, a note that the seller's own share had moved. Nothing said
 * the buyer was owed the difference. So the buyer paid 230, the order, the invoice and every report
 * said 190, and the 40 sat on our side with no screen naming it and no obligation to return it.
 *
 * **That a seller MAY do this at all is a decision, not an accident** (owner, 2026-08-18, asked
 * directly whether it should instead be forced through the returns flow): *"הוא צריך להיות מסוגל
 * לבצע איזשהו סוג של זיכוי חלקי"*. The reasoning is the seller's ordinary week — one line of three
 * cannot be fulfilled, or a parcel arrived late and 20% back is cheaper for everyone than a full
 * return. Routing that through returns would make the seller open a dispute against himself. So the
 * capability stays, and what was missing was never the permission: it was that the money it moved
 * was owed to nobody.
 *
 * `createsRefundObligation` above cannot answer this: it asks whether the order LEFT the sales,
 * which is a whole-order question with a whole-order answer. A partial reduction never trips it —
 * the order still counts, it just counts for less.
 *
 * **Why the amount is the drop in `totalAgorot` and not the drop in the seller's net.** The same
 * reasoning as `refundOwedAgorot`: what the buyer is owed is what left their card and did not buy
 * anything. Commission and shipping are our arrangement with the seller and the carrier, and the
 * buyer is not party to either.
 *
 * **Deliberately silent when the total goes UP.** A seller who adds shipping or removes a discount
 * has not created a debt in either direction that this platform can act on — we cannot charge a
 * card again off the back of an edit, and pretending otherwise would put a positive `refund_due` in
 * the journal that nothing could ever settle. It is `Math.max(0, …)`, and that floor is the
 * decision, not an accident.
 */
export function partialRefundOwedAgorot(
  before: Pick<Order, 'totalAgorot'>,
  after: Pick<Order, 'totalAgorot' | 'paymentStatus' | 'shippingStatus'>,
): number {
  // Nothing was captured, so nothing is owed back — the same first question the whole-order rule
  // asks, and asked of the status table rather than of the word 'paid'.
  if (!orderMoneyWasTaken(after)) return 0;
  // An order that has LEFT the sales is the other function's job, and letting both fire would
  // record the reduction twice: once as a partial refund and once as the whole slice.
  if (!orderCountsAsRevenue(after)) return 0;
  return Math.max(0, before.totalAgorot - after.totalAgorot);
}

/**
 * Record the partial obligation, if the edit created one. Returns the amount owed, or 0.
 *
 * Never throws, for the reason the whole-order version does not: a journal write that fails must
 * not fail the edit it was describing.
 */
export async function recordPartialRefundOwed(
  before: Order,
  after: Order,
  storeSlug: string,
  actor: string,
): Promise<number> {
  const amountAgorot = partialRefundOwedAgorot(before, after);
  if (amountAgorot <= 0) return 0;

  await recordMoneyEvent({
    type: 'refund_due',
    orderId: after.id,
    checkoutRef: after.checkoutRef,
    storeSlug,
    amountAgorot,
    // The totals themselves, not a status: this event is not a transition, and `from`/`to` are what
    // the journal panel renders beside the sentence. A reader asking "why is 40 owed" gets the
    // subtraction that produced it without opening anything else.
    from: String(before.totalAgorot),
    to: String(after.totalAgorot),
    actor,
    detail: `הכסף נגבה בפועל (אסמכתה ${after.paymentRef ?? '—'}) והזמנה זו הוזלה לאחר מכן — פריט שנמחק, משלוח שעודכן או הנחה שניתנה. ההפרש מגיע בחזרה לקונה, ועדיין לא הוחזר.`,
  });

  return amountAgorot;
}
