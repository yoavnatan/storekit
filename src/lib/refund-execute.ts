/**
 * Giving the buyer's money back — the half that was written down and never performed.
 *
 * ── What was broken ──
 * `refund-owed.ts` records that a refund is DUE, and its header said plainly why nothing settled it:
 * *"no provider is chosen yet"*. That stopped being true. So until now a seller could cancel an
 * order he had already been paid for, the journal would carry a `refund_due` forever, `reconcile.ts`
 * would report it as outstanding on the admin dashboard, and the buyer's money simply stayed where
 * it was. `refund_settled` was written by nothing at all.
 *
 * ── Three sources, three amounts, one settlement ──
 * A refund arrives here from three places and they differ only in how much:
 *   · the seller cancels a paid order — the whole slice, goods and delivery alike;
 *   · a return is approved (`return-requests.ts`) — what that request was granted;
 *   · one item is cancelled off an order that otherwise stands (`recordPartialRefundOwed`).
 * They share everything else, which is why they share this module rather than each growing its own
 * PayMe call.
 *
 * ── Two legs, because the money went two ways ──
 * A cart is captured as N+1 charges: one per store into that SELLER's own merchant account, plus
 * the delivery fee into OURS (`payment-split.ts`). So giving back goods and giving back delivery are
 * two different refunds against two different merchants, and a caller has to say which it means.
 * Folding them into one number would try to refund a seller's account for money that never reached
 * it.
 *
 * **The delivery reference is the awkward one, and it is awkward for a real reason** (GO_LIVE
 * §3.1.2): the delivery capture belongs to the CART, not to any one store, so no order row can hold
 * it. It is read back out of the money journal, which is where it was recorded at capture time.
 *
 * ── PayMe's 500-agorot floor, and the thing not to do about it ──
 * A partial refund below ₪5 is refused by PayMe. **The remainder is not rounded up** — that would
 * hand back money nobody agreed to — and it is not silently skipped either. A residue that small can
 * still be given back IN FULL, because a full reversal has no minimum, so the two cases are
 * distinguished here and a caller that cannot use the full path is told the number it was refused
 * over rather than being told a refund succeeded.
 *
 * ── Never throws ──
 * Every path returns an outcome. A refund runs behind a seller pressing "cancel" and behind a job,
 * and a thrown gateway error in either place is an obligation that stays open with nobody told. What
 * this module CANNOT do is hide a failure: an unsettled leg comes back as one, and the obligation
 * stays in the journal for `reconcile.ts` to keep reporting.
 */
import { rows } from './db.js';
import { getStoreBySlug } from './stores.js';
import { merchantAccountFor } from './seller-merchant.js';
import { refundStoreCapture } from './payment-split.js';
import { activePaymeCredentials, PAYME_MIN_REFUND_AGOROT, type PaymeCredentials } from './payment-payme.js';
import { recordMoneyEvent } from './money-events.js';
import { formatAgorot } from './money.js';
import { logError } from './error-log.js';
import type { Order } from './orders.js';

/** Which of the three situations produced this refund. Carried into the journal so a row says what
 *  it was for, and kept as a closed set so a fourth source has to be named rather than appearing as
 *  free text nobody can filter on. */
export type RefundSource = 'seller-cancel' | 'return-approved' | 'partial-item';

const SOURCE_TEXT: Record<RefundSource, string> = {
  'seller-cancel': 'ביטול הזמנה על ידי המוכר',
  'return-approved': 'החזרה שאושרה',
  'partial-item': 'ביטול חלקי של פריט',
};

/**
 * How much to give back, split the way it was taken.
 *
 * The caller decides the split because only the caller knows it: a cancelled order gives back the
 * delivery too, an approved return of one item out of three usually does not.
 */
export interface RefundParts {
  /** Off the SELLER's own capture — goods. */
  goodsAgorot: number;
  /** Off OUR delivery capture. Zero unless the delivery fee is being given back as well. */
  shippingAgorot: number;
}

export type LegOutcome =
  | { leg: 'goods' | 'delivery'; status: 'settled'; amountAgorot: number; providerRef: string }
  /** Nothing to give back on this leg — a zero amount, not a failure. */
  | { leg: 'goods' | 'delivery'; status: 'skipped' }
  /** Below PayMe's partial floor and not the whole capture either. **The obligation stays open** —
   *  this is the case where doing something would be worse than doing nothing. */
  | { leg: 'goods' | 'delivery'; status: 'below-minimum'; amountAgorot: number; minimumAgorot: number }
  /** We hold no reference to refund against: no capture id on the order, or none in the journal for
   *  the delivery. Nothing can be attempted, and somebody has to look. */
  | { leg: 'goods' | 'delivery'; status: 'no-reference' }
  | { leg: 'goods' | 'delivery'; status: 'failed'; error: string };

export interface RefundOutcome {
  /** True only when every leg that had money on it settled. */
  ok: boolean;
  /** What actually went back, agorot. Zero on a total failure. */
  settledAgorot: number;
  legs: LegOutcome[];
}

/**
 * Is this amount refundable as a PARTIAL refund, or only as a whole reversal?
 *
 * Pure, and separated out because it is the rule most likely to be re-implemented by the next
 * caller: **PayMe refuse a partial refund below 500 agorot, and a FULL reversal has no minimum at
 * all**. So a ₪3 residue is refundable — but only by giving the whole capture back, which is a
 * different request and usually a different amount.
 */
export function refundableAsPartial(amountAgorot: number, capturedAgorot: number): boolean {
  if (amountAgorot >= capturedAgorot) return false;   // it is a FULL reversal, not a partial one
  return amountAgorot >= PAYME_MIN_REFUND_AGOROT;
}

/**
 * The delivery capture's PayMe id for one checkout.
 *
 * Read out of the money journal because there is nowhere else: the delivery leg is a charge against
 * OUR merchant account for the whole cart, so it belongs to no order row (GO_LIVE §3.1.2). The row
 * is the `payment_attempted` written at capture time, whose `from` column carries the leg kind and
 * whose `to` column carries the id — columns rather than prose, so this is a lookup and not a parse.
 *
 * `null` means we cannot name the charge, which is a refund that must not be attempted rather than
 * one to guess at.
 */
export async function deliveryCaptureRef(checkoutRef: string): Promise<string | null> {
  if (!checkoutRef) return null;
  const found = await rows<{ to_value: string | null }>(
    `SELECT to_value FROM money_events
      WHERE checkout_ref = $1 AND type = 'payment_attempted' AND from_value = 'delivery'
      ORDER BY at DESC LIMIT 1`,
    [checkoutRef],
  );
  return found[0]?.to_value || null;
}

/**
 * Give money back for one order, and write the settlement that closes the obligation.
 *
 * The seller's merchant account is resolved from the STORE rather than taken from the caller: an
 * order names a store, a store names a seller, and a seller has exactly one clearing account. A
 * caller passing an account id would be a second place that mapping could be got wrong, on the path
 * where getting it wrong means refunding somebody else's merchant.
 */
export async function settleRefund(
  input: { order: Order; storeSlug: string; parts: RefundParts; source: RefundSource; actor: string },
  creds: PaymeCredentials | null = activePaymeCredentials(),
): Promise<RefundOutcome> {
  const { order, storeSlug, parts, source, actor } = input;
  const legs: LegOutcome[] = [];
  let settled = 0;

  // No gateway: nothing can be refunded, and the obligation stays exactly where `refund-owed.ts`
  // put it. Reported as a failure rather than as a success with nothing behind it — a `refund_due`
  // that closes itself because no provider was configured is the one outcome that would make the
  // journal lie.
  if (!creds) {
    return { ok: false, settledAgorot: 0, legs: [
      ...(parts.goodsAgorot > 0 ? [{ leg: 'goods' as const, status: 'no-reference' as const }] : []),
      ...(parts.shippingAgorot > 0 ? [{ leg: 'delivery' as const, status: 'no-reference' as const }] : []),
    ] };
  }

  // ── The goods leg: the seller's own capture ──
  if (parts.goodsAgorot > 0) {
    const store = await getStoreBySlug(storeSlug);
    const account = store ? await merchantAccountFor(store.sellerId) : null;
    // `order.paymentRef` is THIS store's capture id under the split model — `markOrdersPaid` writes
    // the per-store reference onto each order rather than the cart-wide one.
    if (!account?.providerRef || !order.paymentRef) {
      legs.push({ leg: 'goods', status: 'no-reference' });
    } else {
      // What was captured on this leg. The order's own goods total, which is what left the buyer's
      // card into this seller's account — the delivery rode on a different charge entirely.
      const capturedGoods = Math.max(0, order.totalAgorot - order.shippingAgorot);
      legs.push(await refundLeg('goods', {
        sellerPaymeId: account.providerRef,
        paymeSaleId: order.paymentRef,
        amountAgorot: parts.goodsAgorot,
        capturedAgorot: capturedGoods,
      }, creds));
    }
  } else {
    legs.push({ leg: 'goods', status: 'skipped' });
  }

  // ── The delivery leg: our own merchant account ──
  if (parts.shippingAgorot > 0) {
    const ref = order.checkoutRef ? await deliveryCaptureRef(order.checkoutRef) : null;
    if (!ref || !creds.ownMerchantId) {
      legs.push({ leg: 'delivery', status: 'no-reference' });
    } else {
      // ⚠️ The delivery capture covers the WHOLE cart, so on a multi-store purchase this order's
      // share is a partial refund of it however complete the cancellation is. `capturedAgorot` is
      // therefore this order's shipping and not the charge's total — passing the charge's total
      // would make a one-store cart's full reversal look like a partial one and re-impose a floor
      // that does not apply to it.
      legs.push(await refundLeg('delivery', {
        sellerPaymeId: creds.ownMerchantId,
        paymeSaleId: ref,
        amountAgorot: parts.shippingAgorot,
        capturedAgorot: order.shippingAgorot,
      }, creds));
    }
  } else {
    legs.push({ leg: 'delivery', status: 'skipped' });
  }

  for (const leg of legs) if (leg.status === 'settled') settled += leg.amountAgorot;
  const attempted = legs.filter((l) => l.status !== 'skipped');
  const ok = attempted.length > 0 && attempted.every((l) => l.status === 'settled');

  if (settled > 0) {
    // **The row `reconcile.ts` pairs against a `refund_due`**, which is why `orderId` is not
    // optional here: that query joins on the order id, and a settlement without one would leave the
    // obligation reported as outstanding forever while the money had really gone back.
    await recordMoneyEvent({
      type: 'refund_settled',
      orderId: order.id,
      ...(order.checkoutRef ? { checkoutRef: order.checkoutRef } : {}),
      storeSlug,
      amountAgorot: settled,
      actor,
      detail: `${SOURCE_TEXT[source]} · הוחזר לקונה · ${legs
        .filter((l): l is Extract<LegOutcome, { status: 'settled' }> => l.status === 'settled')
        // `formatAgorot`, never the integer: an amount inside a sentence a person reads is shekels
        // (`lib/money.ts`), and this row is read by whoever is asking where a buyer's money went.
        .map((l) => `${l.leg === 'delivery' ? 'משלוח' : 'סחורה'} ${formatAgorot(l.amountAgorot)} · אסמכתה ${l.providerRef}`)
        .join(' · ')}`,
    }).catch(() => { /* the money really went back; a lost journal row is not a lost refund */ });
  }

  if (!ok) {
    // Loud, and this is the case worth being loud about: a person is owed money, the obligation is
    // in the journal, and nothing else is going to notice. `reconcile.ts` reports the outstanding
    // total, but a total is not a name and nobody reads it the day it happens.
    await logError({
      source: 'server',
      route: 'refund',
      message: `refund not fully settled for order ${order.id} (${source}): ${JSON.stringify(legs)}`,
      resolutionHint: `החזר לקונה לא הושלם בהזמנה ${order.id}. החוב רשום ביומן הכספי ומופיע כפתוח בדוח ההתאמה — צריך להחזיר ידנית אצל PayMe או לתקן את הסיבה ולנסות שוב.`,
    }).catch(() => { /* nothing left to try */ });
  }

  return { ok, settledAgorot: settled, legs };
}

/**
 * One PayMe refund, with the floor applied before the call.
 *
 * The whole-vs-partial decision is made HERE and not by the caller, because it is the one that
 * carries PayMe's rule: an amount at or above what was captured is sent as a full reversal with no
 * amount at all — which is what makes a ₪3 residue refundable — and anything below their floor is
 * refused with the number in it rather than rounded up to something nobody agreed to.
 */
async function refundLeg(
  leg: 'goods' | 'delivery',
  input: { sellerPaymeId: string; paymeSaleId: string; amountAgorot: number; capturedAgorot: number },
  creds: PaymeCredentials,
): Promise<LegOutcome> {
  const whole = input.amountAgorot >= input.capturedAgorot;
  if (!whole && input.amountAgorot < PAYME_MIN_REFUND_AGOROT) {
    return { leg, status: 'below-minimum', amountAgorot: input.amountAgorot, minimumAgorot: PAYME_MIN_REFUND_AGOROT };
  }
  const res = await refundStoreCapture({
    sellerPaymeId: input.sellerPaymeId,
    paymeSaleId: input.paymeSaleId,
    // Omitted for a whole reversal — PayMe's own rule, and the only way an amount under their floor
    // can be given back at all.
    ...(whole ? {} : { amountAgorot: input.amountAgorot }),
  }, creds);
  return res.ok
    ? { leg, status: 'settled', amountAgorot: whole ? input.capturedAgorot : input.amountAgorot, providerRef: input.paymeSaleId }
    : { leg, status: 'failed', error: res.error };
}
