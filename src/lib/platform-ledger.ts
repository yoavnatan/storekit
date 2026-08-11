import type { PlatformAccrual } from './payouts.js';
import type { PayoutPlan } from './payout-run.js';

/**
 * **The platform's own balance sheet: what we are holding that is not ours, and what is.**
 *
 * The owner's question, verbatim (`CURRENT_TASK.md` → סשן ב׳ §3): *"אני צריך לנהל את זה חשבונאית
 * נכון — מה ההכנסות הקרובות, מה אני מחזיק שהוא לא שלי אלא של המוכר"*. Under the agent model
 * (AI_INSTRUCTIONS → Payment architecture) that is not a rhetorical question: the buyer's payment
 * discharges their debt to the seller at the instant it lands, so from that moment we are holding
 * somebody else's money, and how much is a figure a business has to be able to state.
 *
 * ── Why it could not be read off any existing screen ──
 * Every money surface before this one is **per seller**: the payout plan lists who is owed what, the
 * seller cards each show one balance. Summing the plan's rows does NOT give the liability, and the
 * gap is not small — those rows exist only for sellers with money already out of hold, so a normal
 * week's worth of undelivered orders is missing from the total entirely. The platform figure has to
 * come from the platform aggregate (`payouts.ts#getPlatformAccrual`).
 *
 * ── The one identity everything here rests on ──
 *   liability = accrued net − paid out + adjustments
 * and it splits exactly two ways, released and held:
 *   liability = releasedLiability + heldAgorot
 * `tests/reporting-invariants.test.ts` asserts both, because the whole value of this card is that
 * its parts add up — three tiles that each look plausible and do not sum are worse than no card.
 *
 * ── Two things this deliberately does NOT claim ──
 * **It is not our cash balance.** What is actually in the company's bank account depends on when the
 * processor settles, which no code here knows and no number here pretends to. This is what we OWE
 * and what we have EARNED, which is the accounting question; the bank statement is a different one.
 *
 * ── Nothing here is floored at zero, and that is a decision ──
 * `releasedAgorot` and `platformIncomeAgorot` can both go negative, by the same route: a payout
 * goes out, and an order behind it is then cancelled, so what was released shrinks below what has
 * already been sent. `planPayouts` floors its per-seller figure because that one is an instruction
 * to transfer money and a negative there would read as a transfer the other way. These are not
 * instructions — they are a balance sheet, and a balance sheet that cannot show an overpayment
 * hides the one state worth acting on. Flooring would also break the identity above, which is the
 * property the whole card is worth reading for.
 *
 * **`platformIncome` is commission only.** Subscriptions and the ad margin are the other two thirds
 * of what the platform earns (`platform-revenue.ts`, on the Performance tab, over a date range) and
 * they are billed to the seller's card, never withheld from a payout — folding them in here would
 * report income that this ledger has no claim on. Commission is the part that comes off at source,
 * which is why it and only it belongs beside the liability it is deducted from.
 */

export interface PlatformLedger {
  /** Sellers' money in our hands, all of it: released and still in hold. The liability. */
  sellerFundsAgorot: number;
  /** Out of hold, not yet transferred — what a payout run may act on today. */
  releasedAgorot: number;
  /** Still in hold: paid for, not yet through the delivery clock (`payout-hold.ts`). */
  heldAgorot: number;
  /** Of `releasedAgorot`, what the next run actually sends, and what it cannot. Straight from the
   *  plan, so this card and the payouts tab cannot state two different transfers. */
  nextPayoutAgorot: number;
  nextPayoutDayISO: string;
  stuckNoBankAgorot: number;
  belowMinimumAgorot: number;
  /** Commission earned on everything accrued, minus what past payouts already took at source — the
   *  platform's own money still sitting in the same pot as the sellers'. */
  platformIncomeAgorot: number;
  /** The slice of it the next payout deducts. "ההכנסות הקרובות", and it is a date away. */
  incomeAtNextPayoutAgorot: number;
}

export function buildPlatformLedger(accrual: PlatformAccrual, plan: PayoutPlan): PlatformLedger {
  // Adjustments are signed: a clawback is negative and reduces what we owe (`payouts.ts`).
  const sellerFundsAgorot = accrual.netAgorot - plan.paidOutAgorot + plan.adjustmentsAgorot;
  // Every payout ever made came out of released money — an in-hold slice cannot be transferred —
  // so the same two terms belong on the released side, and the held side is then the remainder
  // rather than a second subtraction of the same rows.
  const releasedAgorot = accrual.releasedNetAgorot - plan.paidOutAgorot + plan.adjustmentsAgorot;
  return {
    sellerFundsAgorot,
    releasedAgorot,
    // Not `accrual.netAgorot - accrual.releasedNetAgorot` — identical arithmetic today, and it would
    // stop being identical the moment either half above gains a term. Written as the difference of
    // the two figures shown, so the card's own numbers are what add up.
    heldAgorot: sellerFundsAgorot - releasedAgorot,
    nextPayoutAgorot: plan.payableAgorot,
    nextPayoutDayISO: plan.payoutDayISO,
    stuckNoBankAgorot: plan.noBankAgorot,
    belowMinimumAgorot: plan.belowMinimumAgorot,
    // EARNED minus COLLECTED, and the distinction is the whole point of putting it on a balance
    // sheet: commission is taken off at source when a payout goes out, so until then it is our
    // money sitting inside the same pot as the sellers'. Lifetime commission earned is a different
    // question, it is a performance figure, and the Performance tab answers it over a date range.
    platformIncomeAgorot: accrual.commissionAgorot - plan.commissionSettledAgorot,
    incomeAtNextPayoutAgorot: plan.payableCommissionAgorot,
  };
}
