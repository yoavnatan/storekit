import { recordMoneyEvent } from './money-events.js';
import { orderCountsAsRevenue, orderMoneyWasTaken } from './order-status-rules.js';
import { orderHold } from './payout-hold.js';
import { orderNetForStore } from './admin-stats.js';
import { commissionOnAgorot, commissionPercentForTier } from './pricing.js';
import { getSellerById } from './seller-auth.js';
import { recordAdjustment } from './payouts.js';
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
  /** The store's owner. When given, a refund on money that has already left the hold also debits
   *  them — see `recordSellerClawback`. Optional so a caller with no seller in hand (a future
   *  admin path, a webhook) still records the buyer-side obligation, which is the more important
   *  half and must never depend on the other. */
  sellerId?: string,
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
  if (sellerId) await recordSellerClawback(before, after, storeSlug, sellerId);
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
  /** The store's owner, so money already released to them is clawed back too. Optional for the
   *  same reason as above: the buyer-side obligation is the half that must never depend on the
   *  other being available. */
  sellerId?: string,
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

  if (sellerId) await recordPartialSellerClawback(before, after, storeSlug, sellerId);
  return amountAgorot;
}

/**
 * The seller's side of a partial refund.
 *
 * Mirrors `recordSellerClawback` and differs in exactly one way: the whole-order version claws back
 * the seller's entire net share because the sale was undone, while this one claws back only the
 * DROP in that share, because the sale still stands for the reduced amount. Both ask the hold
 * first, and both are no-ops while the money is still held — an order whose funds never left is
 * corrected for free by the balance arithmetic the moment the total changes.
 */
export async function recordPartialSellerClawback(
  before: Order,
  after: Order,
  storeSlug: string,
  sellerId: string,
): Promise<number> {
  if (partialRefundOwedAgorot(before, after) <= 0) return 0;

  // The state BEFORE the edit, for the same reason the whole-order version reads it there: the
  // question is whether this money had already been released by the time it was reduced.
  const holdBefore = orderHold(before);
  if (holdBefore.state !== 'releasable') return 0;

  const seller = await getSellerById(sellerId);
  const percent = commissionPercentForTier(seller?.tier);
  const netBefore = orderNetForStore(before, storeSlug);
  const netAfter = orderNetForStore(after, storeSlug);
  const shareBefore = netBefore - commissionOnAgorot(netBefore, percent);
  const shareAfter = netAfter - commissionOnAgorot(netAfter, percent);
  const drop = shareBefore - shareAfter;
  if (drop <= 0) return 0;

  // A DIFFERENT `kind` from the whole-order clawback on purpose. That one is idempotent on
  // (order, kind) so a repeated cancellation debits once — which is right for an event that can
  // only happen once. An edit can happen many times, and each reduction is its own debit, so
  // sharing the kind would silently swallow every edit after the first.
  await recordAdjustment({
    sellerId,
    orderId: after.id,
    kind: 'refund_clawback_partial',
    amountAgorot: -drop,
    detail: `הזמנה ${after.id.slice(0, 8)} (${storeSlug}) הוזלה אחרי שהכסף כבר שוחרר למוכר. ההפרש בחלקו של המוכר מקוזז מהתשלום הבא.`,
  });
  return drop;
}

/**
 * The seller's side of the same event: when the platform gives money back, whose money is it?
 *
 * **This is new with the agent model and it closes a real hole.** Under the sub-merchant model the
 * processor had already paid the seller and a refund was, awkwardly, between them. Now the platform
 * holds the money, so a refund comes out of a specific pot — and if nothing debited the seller, the
 * platform would silently absorb every post-hold cancellation out of its own funds, invisibly,
 * with the seller keeping the proceeds of a sale that was undone.
 *
 * ── The rule, and why it needs no join against `seller_payouts` ──
 * Ask the hold, not the payout table. An order still `held` needs NO adjustment: the money never
 * left, and dropping out of `orderCountsAsRevenue` already removes it from the balance — the
 * account arithmetic does the work for free. An order that was `releasable` is either already
 * transferred or sitting in the pool about to be, and a debit is exactly right in both cases: it
 * claws back the first and reduces the second by the same amount. So the question is one pure
 * function call, and there is no window in which a payout running concurrently changes the answer.
 *
 * ── The amount is the SELLER'S share, not the buyer's refund ──
 * `refundOwedAgorot` is the whole slice including shipping, because that is what left the buyer's
 * card. The seller never received that: they were owed the net subtotal minus commission, and
 * shipping went to the carrier. Clawing back the buyer's figure would take money the seller was
 * never given. The commission needs no reversal either — the order has left every revenue sum, so
 * it was never earned.
 */
export async function recordSellerClawback(
  before: Pick<Order, 'paymentStatus' | 'shippingStatus'>,
  after: Order,
  storeSlug: string,
  sellerId: string,
): Promise<number> {
  if (!createsRefundObligation(before, after)) return 0;

  // Asked of the state BEFORE the cancellation: after it, the order no longer counts and
  // `orderHold` correctly answers 'not_payable' for everything, which would claw back nothing at
  // all. The question is "had this money been released by the time it was undone", and only the
  // prior state can answer it.
  const holdBefore = orderHold({ ...before, paidAt: after.paidAt, deliveredAt: after.deliveredAt });
  if (holdBefore.state !== 'releasable') return 0;

  const net = orderNetForStore(after, storeSlug);
  const seller = await getSellerById(sellerId);
  const commission = commissionOnAgorot(net, commissionPercentForTier(seller?.tier));
  const sellerShare = net - commission;
  if (sellerShare <= 0) return 0;

  // Negative: this reduces what we owe. Idempotent on (order, kind) in the database, so a second
  // cancellation of an already-cancelled order debits once.
  await recordAdjustment({
    sellerId,
    orderId: after.id,
    kind: 'refund_clawback',
    amountAgorot: -sellerShare,
    detail: `הזמנה ${after.id.slice(0, 8)} (${storeSlug}) יצאה מהמכירות אחרי שהכסף כבר שוחרר למוכר. חלקו של המוכר מקוזז מהתשלום הבא.`,
  });
  return sellerShare;
}
