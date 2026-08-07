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
 * debt exists, by the code that creates it. `refund_settled` is written when the money actually goes
 * back — which needs the payment provider's refund call, and no provider is chosen yet
 * (GO_LIVE_CHECKLIST §3). So nothing writes the second one today, ON PURPOSE: every obligation stays
 * open, `reconcile.ts` reports the outstanding total on the admin dashboard, and the day a provider
 * is wired the settlement closes them off instead of the record having quietly closed itself.
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
    // Written for whoever reads the journal months later, which is the only audience it has.
    detail: `payment was captured (ref=${after.paymentRef ?? '—'}) and the order was ${after.shippingStatus}; this amount is owed back to the buyer and no refund has been recorded`,
  });
  return amountAgorot;
}
