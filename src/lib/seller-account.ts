import { commissionOnAgorot, commissionPercentForTier } from './pricing.js';
import { orderHold, type HoldableOrder, type OrderHold } from './payout-hold.js';
import { businessTodayISO } from './business-day.js';
import type { SellerTierId } from './pricing.js';

/**
 * What the platform OWES a seller right now, and how much of it is still at risk.
 *
 * `seller-balance.ts` answers "how much has this seller earned" — a reporting figure, derived from
 * the revenue map the admin cards already hold, costing no query. That module and its no-table
 * argument stand unchanged. This one answers the question the agent model added and that one
 * cannot: **of what they earned, how much may actually be sent, when, and what has already gone.**
 * The difference is that a balance is a sum over orders while a payout obligation is a sum over
 * orders MINUS things that really happened — transfers, chargebacks, clawbacks — so this needs
 * per-order dates and two stored tables, and `seller-balance.ts` needs neither.
 *
 * ── Pure, and taking its rows as parameters ──
 * Same rule as `admin-stats.ts`: a GROUP BY belongs in the database, everything else belongs in a
 * function you can assert against without one. Every number below is reachable in a unit test with
 * three literals, which matters more here than anywhere else in the app — this is the arithmetic
 * that decides how much money leaves the company's bank account.
 *
 * ── The invariant, stated once so the test can quote it ──
 *     payableNow = releasable − paidOut + adjustments,   floored at 0
 * and nothing may ever produce a payout larger than `releasable`. Money still inside its hold is
 * not payable no matter what the adjustments say, which is why `heldAgorot` is tracked separately
 * rather than folded into one balance: a single number cannot express "you have earned this but it
 * is not yours to draw yet", and a seller looking at one number will read it as the second.
 *
 * ── Where a negative lands ──
 * Adjustments are signed and can exceed what is releasable — a chargeback on an order already paid
 * out is exactly that case. The result is NOT a negative payout (there is no such transfer) and it
 * is NOT dropped: it becomes `carriedAgorot`, a debt that reduces the next period's payable, and it
 * is shown to the seller. A debt that is silently floored away is a hole in the platform's own
 * money that no screen reports.
 */

/** One store's slice of one order, as this module needs it. */
export interface AccountSlice {
  orderId: string;
  storeSlug: string;
  /** `admin-stats.ts#orderNetForStore` — the net subtotal, discount already off. NOT the order
   *  total: shipping is the carrier's money and was never the seller's (AI_INSTRUCTIONS). */
  netAgorot: number;
  /** The order's payment/shipping status and its two clocks. */
  order: HoldableOrder;
}

/** A payout row as stored. `failed` is excluded by the caller, not here — see `sumPayouts`. */
export interface AccountPayout {
  amountAgorot: number;
  status: 'pending' | 'sent' | 'paid' | 'failed';
}

/** A signed ledger adjustment. Negative reduces what we owe. */
export interface AccountAdjustment {
  amountAgorot: number;
}

export interface AccountSliceView extends AccountSlice {
  hold: OrderHold;
  commissionAgorot: number;
  /** net − commission: the seller's share of this slice. */
  netOfCommissionAgorot: number;
}

export interface SellerAccount {
  commissionRate: number;
  /** Every counting slice, gross. */
  grossAgorot: number;
  commissionAgorot: number;
  /** Seller's share still inside its hold window. Earned, not yet drawable. */
  heldAgorot: number;
  /** Seller's share out of hold — the ceiling on everything below. */
  releasableAgorot: number;
  /** Already sent or in flight. Failed payouts are not counted: the money came back. */
  paidOutAgorot: number;
  /** Signed sum of chargebacks, clawbacks and corrections. */
  adjustmentsAgorot: number;
  /** What a payout run may send today. Never negative, never above `releasableAgorot`. */
  payableNowAgorot: number;
  /** Debt carried into the next period when adjustments exceed what is releasable. Positive
   *  number meaning "the seller owes us this much", which is why it is not just a negative
   *  `payableNow` — a sign that means two different things on one screen gets misread. */
  carriedAgorot: number;
  /** Per slice, for the seller's "in hold" list. Ordered as the caller supplied them. */
  slices: AccountSliceView[];
}

/** Payouts that represent money gone or going. A `failed` transfer bounced, so its amount is owed
 *  again — counting it would silently withhold it forever, which is the worst direction to be
 *  wrong in and is invisible from every screen.
 *
 *  Exported because `payouts.ts#getPayableNowForSeller` answers the same question from the same
 *  rows without building the whole per-slice account, and "which payouts count" is exactly the
 *  rule that must not have a second spelling. */
export function sumPayouts(payouts: readonly AccountPayout[]): number {
  let total = 0;
  for (const p of payouts) if (p.status !== 'failed') total += p.amountAgorot;
  return total;
}

/**
 * The invariant in the header, as one function: `releasable − paidOut + adjustments`, SIGNED.
 *
 * Three callers compute this — this module (for the seller's own screen), `payout-run.ts#planPayouts`
 * (for the transfer that actually leaves) and `payouts.ts#getPayableNowForSeller` (for the header's
 * alert dot). They differ in where the three inputs come from, which is legitimate and documented;
 * they must not differ in what is done with them. A sign error here is a seller paid twice or not
 * at all, so it gets one home rather than three lines that happen to match today.
 *
 * Signed rather than floored: the caller decides whether a negative is a debt to carry
 * (`carriedAgorot`) or simply nothing to send, and those are different screens.
 */
export function payoutBalanceAgorot(
  releasableAgorot: number,
  paidOutAgorot: number,
  adjustmentsAgorot: number,
): number {
  return releasableAgorot - paidOutAgorot + adjustmentsAgorot;
}

export function buildSellerAccount(
  tier: SellerTierId | undefined,
  slices: readonly AccountSlice[],
  payouts: readonly AccountPayout[],
  adjustments: readonly AccountAdjustment[],
  todayISO: string = businessTodayISO(),
): SellerAccount {
  const commissionRate = commissionPercentForTier(tier);

  let grossAgorot = 0;
  let commissionAgorot = 0;
  let heldAgorot = 0;
  let releasableAgorot = 0;

  const views: AccountSliceView[] = slices.map((slice) => {
    const hold = orderHold(slice.order, todayISO);
    // Commission is rounded PER SLICE and then summed, never taken off the total — the same choice
    // `seller-balance.ts` and `platform-performance.ts` both make, and for the same reason: the
    // rounding has to happen where the rate is applied, so that the per-order figures a seller can
    // add up by hand match the total we show them.
    const sliceCommission = commissionOnAgorot(slice.netAgorot, commissionRate);
    const netOfCommission = slice.netAgorot - sliceCommission;

    // A slice that will never pay out contributes to NOTHING here — not gross, not commission.
    // Including it in gross while excluding it from held/releasable would produce a page where the
    // parts visibly do not sum to the whole, which is the class `reporting-invariants.test.ts`
    // exists to catch.
    if (hold.state !== 'not_payable') {
      grossAgorot += slice.netAgorot;
      commissionAgorot += sliceCommission;
      if (hold.state === 'releasable') releasableAgorot += netOfCommission;
      else heldAgorot += netOfCommission;
    }

    return { ...slice, hold, commissionAgorot: sliceCommission, netOfCommissionAgorot: netOfCommission };
  });

  const paidOutAgorot = sumPayouts(payouts);
  let adjustmentsAgorot = 0;
  for (const a of adjustments) adjustmentsAgorot += a.amountAgorot;

  const balance = payoutBalanceAgorot(releasableAgorot, paidOutAgorot, adjustmentsAgorot);
  const payableNowAgorot = Math.max(0, balance);
  const carriedAgorot = Math.max(0, -balance);

  return {
    commissionRate,
    grossAgorot,
    commissionAgorot,
    heldAgorot,
    releasableAgorot,
    paidOutAgorot,
    adjustmentsAgorot,
    payableNowAgorot,
    carriedAgorot,
    slices: views,
  };
}
