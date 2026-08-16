import { businessTodayISO } from './business-day.js';
import { formatAgorot } from './money.js';
import { MIN_PAYOUT_AGOROT, nextPayoutDayISO } from './payout-schedule.js';
import {
  getReleasableBySeller,
  getPayoutTotalsBySeller,
  getAdjustmentTotalsBySeller,
  createPayout,
  type BankSnapshot,
} from './payouts.js';
import { getAllSellers, type Seller } from './seller-auth.js';
import { planPlatformInvoice } from './invoicing/index.js';
import { hasPayableBank, type PayoutDetails } from './payout-details.js';

/**
 * The weekly payout run: turn every seller's released balance into a payout row.
 *
 * ── What this does NOT do, and it is the important half ──
 * It does not move money. It creates `seller_payouts` rows in `pending`, and something else — a
 * bank file, an API, a person — turns those into transfers and calls `setPayoutStatus`. That split
 * is deliberate and it is the same reasoning `payment.ts` records for authorize/capture: the step
 * that can be safely re-run is separated from the step that cannot, and the irreversible one goes
 * last. A run that crashes halfway has created some rows and sent nothing.
 *
 * ── Why it infers NOTHING from elapsed time ──
 * A scheduled job cannot know how long it has been since the last one — the server may have been
 * down for a week, the timer may have fired twice, two instances may run together. So this asks the
 * calendar what day it is, asks the database what is releasable, and lets a UNIQUE constraint
 * decide whether the answer has already been acted on (`project_scheduler`, and `createPayout`'s
 * header). "Has this run already been paid" is never a question this code asks; it inserts and
 * reads the affected-row count.
 *
 * ── The three reasons a seller is skipped, all of which accrue rather than forfeit ──
 *   1. Below `MIN_PAYOUT_AGOROT` — a transfer that costs more to send than it moves. Rolls over.
 *   2. No bank details — the seller has never filled them in. Rolls over, and their screen says so.
 *      They are never asked for these at registration (`feedback_seller_form_burden`), so this is a
 *      normal state for a seller's first weeks, not an error.
 *   3. A carried debt exceeds the balance — a chargeback larger than what is released. Nothing to
 *      send; the debt stays and reduces the next run.
 * None of the three loses the seller a shekel, and `terms.astro` says so in those words.
 */

export interface PayoutRunResult {
  /** The run these payouts belong to: the payout day itself, 'YYYY-MM-DD' on the business calendar.
   *  Rows written before 2026-08-16 carry a 'YYYY-MM' month key from the monthly cadence — nothing
   *  parses this, it is an identity for the run and a label on a report, so both shapes coexist. */
  periodKey: string;
  /** Sellers a payout row was created for. */
  created: number;
  totalAgorot: number;
  /** Below the minimum. */
  skippedBelowMinimum: number;
  /** No usable bank details on file. */
  skippedNoBank: number;
  /** Already had a payout for this period — a re-run, and the normal case for the second tick. */
  skippedAlreadyPaid: number;
}

/** The bank details a transfer needs, or null when the seller has not supplied them.
 *  All four or none: a transfer missing any one of them cannot be made, and a half-filled form
 *  must read as "not ready" rather than produce a payout that will bounce. The question itself is
 *  `hasPayableBank`, shared with the seller's own screen — a banner saying "add your bank details"
 *  while this run would happily pay (or the reverse) is worse than either alone. */
function bankOf(seller: PayoutDetails): BankSnapshot | null {
  if (!hasPayableBank(seller)) return null;
  return {
    code: seller.bankCode!, branch: seller.bankBranch!,
    account: seller.bankAccount!, holder: seller.bankAccountHolder!,
  };
}

/**
 * ── The DECISION, separated from the act ──
 *
 * `planPayouts` answers "who gets paid on the next payout day, how much, and why not", and writes
 * nothing. `runPayouts` is that answer plus the rows.
 *
 * They are split because the owner has to SEE the coming transfer before it happens — how much
 * leaves the company's account on the coming payout day, and which sellers are stuck on a form
 * nobody has asked them to fill in. A screen that computed that separately would be a second
 * definition of who gets paid, and when two definitions of that disagree, one of them is a number
 * somebody acted on.
 */
export type PayoutState =
  /** Would be transferred on the payout day. */
  | 'payable'
  /** Real money, below the transfer minimum. Rolls over; nothing is deducted. */
  | 'below_minimum'
  /** Real money with nowhere to send it — the seller has not filled in their bank details. */
  | 'no_bank'
  /** A payout for this period already exists. A re-run, and the normal case for a second tick. */
  | 'already_paid'
  /** Everything released has already been sent. The steady state, and most rows most runs. */
  | 'settled';

export interface PayoutPlanRow {
  sellerId: string;
  sellerName: string;
  sellerEmail: string;
  /** What this seller is owed right now: released − already paid ± adjustments, floored at 0.
   *  A balance that goes below zero is a carried DEBT, and `seller-account.ts` is what reports it —
   *  a negative number on a "to be paid" column would be read as a payment. */
  balanceAgorot: number;
  /** Commission this payout would settle — the INCREMENT, never the cumulative figure. */
  commissionAgorot: number;
  state: PayoutState;
  bank: BankSnapshot | null;
  /** Carried through so `runPayouts` can invoice without a second read per seller. Narrow on
   *  purpose: the invoice needs the business type, and nothing here needs a password hash. */
  seller: Pick<Seller, 'id' | 'name' | 'email' | 'tier' | 'businessType'>;
}

export interface PayoutPlan {
  periodKey: string;
  /** Business day the transfer would go out. */
  payoutDayISO: string;
  /** Every seller with money out of hold. Ordered by what is owed, most first. */
  rows: PayoutPlanRow[];
  /** Sum of the `payable` rows — what actually leaves the company's account. */
  payableAgorot: number;
  payableSellers: number;
  /** Real money that will NOT go out, and why. Both accrue; nothing is ever forfeited. */
  noBankAgorot: number;
  noBankSellers: number;
  belowMinimumAgorot: number;
  belowMinimumSellers: number;
  /** Commission the payable rows would settle — what the platform actually earns on the next run.
   *  The INCREMENT, like `PayoutPlanRow.commissionAgorot` it is summed from. */
  payableCommissionAgorot: number;
  /**
   * Platform-wide totals this run already has in hand, carried out rather than re-queried.
   *
   * They are not about the next payout at all — they are the two rows the platform's own balance
   * sheet needs (`platform-ledger.ts`): everything ever transferred to sellers, and every manual
   * ledger correction. The admin overview asks for them on every load, and asking the same two
   * aggregates a second time to answer a question this function had already answered would be two
   * reads of the same fact that can disagree by whatever lands between them.
   */
  paidOutAgorot: number;
  /** Commission those transfers already took off at source — what the platform has collected, as
   *  opposed to earned. Excludes failed payouts, like `paidOutAgorot` beside it. */
  commissionSettledAgorot: number;
  adjustmentsAgorot: number;
}

/**
 * Who would be paid, how much, and why not — reading only.
 *
 * **Four queries, whatever the platform's size.** The two per-seller reads this replaced were fine
 * for a once-a-month job and are not fine for a SCREEN: a page costing 2N queries is the shape
 * `feedback_scalability` exists to reject. Both sums arrive as one aggregate each
 * (`payouts.ts#getPayoutTotalsBySeller`), which are plain `SUM`s keyed by `seller_id` with no join
 * to orders. `getReleasableBySeller` deliberately stays its own query — folding THAT one in is the
 * join that could silently under- or over-pay every seller at once.
 */
export async function planPayouts(todayISO: string = businessTodayISO()): Promise<PayoutPlan> {
  // ── The period key IS the payout day, and that is a change of meaning as well as of format ──
  // It used to be the month `todayISO` fell in, which quietly answered a different question from the
  // one beside it: viewed on the 15th, the plan was keyed to THIS month while `payoutDayISO` pointed
  // at next month's run. Keying both to the same day makes the key say what it is used for — "the
  // run this plan becomes" — and keeps `already_paid` honest across a re-tick.
  const periodKey = nextPayoutDayISO(todayISO);
  const [releasable, totals, adjustments, sellers] = await Promise.all([
    getReleasableBySeller(todayISO),
    getPayoutTotalsBySeller(periodKey),
    getAdjustmentTotalsBySeller(),
    getAllSellers(),
  ]);
  const byId = new Map(sellers.map((s) => [s.id, s]));

  const rows: PayoutPlanRow[] = [];
  for (const row of releasable) {
    const seller = byId.get(row.sellerId);
    if (!seller) continue;
    const paid = totals.get(row.sellerId);
    const paidOut = paid?.paidOutAgorot ?? 0;
    const adjusted = adjustments.get(row.sellerId) ?? 0;
    const balance = row.netAgorot - paidOut + adjusted;

    // ── The commission INCREMENT, and why it is not `row.commissionAgorot` ──
    // `getReleasableBySeller` is cumulative: it answers "commission on everything out of hold",
    // which still includes every earlier period, because a balance that sat below the minimum last
    // run is still releasable in this one. Harmless in a balance — prior payouts are subtracted
    // above — and NOT harmless on the tax invoice, which would bill the seller a second time for
    // commission they were already invoiced for. So each payout records the slice it settled and
    // the next one subtracts them all. A failed payout is excluded here for the same reason it is
    // excluded from `paidOut`: its commission was never really settled either.
    const commissionAgorot = Math.max(0, row.commissionAgorot - (paid?.commissionSettledAgorot ?? 0));
    const bank = bankOf(seller);

    // The order of these tests IS the order of the reasons, and it matters on screen. `settled` is
    // split out of `below_minimum` for one reason: a seller paid in full last run has a balance
    // of zero, zero is below the minimum, and listing them that way buries the handful of sellers
    // who are genuinely stuck among everyone who is perfectly fine.
    const state: PayoutState =
      paid?.hasPeriod ? 'already_paid'
      : balance <= 0 ? 'settled'
      : balance < MIN_PAYOUT_AGOROT ? 'below_minimum'
      : !bank ? 'no_bank'
      : 'payable';

    rows.push({
      sellerId: row.sellerId,
      sellerName: seller.name,
      sellerEmail: seller.email,
      balanceAgorot: Math.max(0, balance),
      commissionAgorot,
      state,
      bank,
      seller: {
        id: seller.id, name: seller.name, email: seller.email,
        ...(seller.tier ? { tier: seller.tier } : {}),
        ...(seller.businessType ? { businessType: seller.businessType } : {}),
      },
    });
  }

  // Most owed first, then by id so two equal balances do not reshuffle between loads (§7.13).
  rows.sort((a, b) => b.balanceAgorot - a.balanceAgorot || a.sellerId.localeCompare(b.sellerId));
  const sum = (st: PayoutState) => rows.reduce((t, r) => (r.state === st ? t + r.balanceAgorot : t), 0);
  const count = (st: PayoutState) => rows.reduce((t, r) => (r.state === st ? t + 1 : t), 0);

  return {
    periodKey,
    payoutDayISO: periodKey,
    rows,
    payableAgorot: sum('payable'),
    payableSellers: count('payable'),
    noBankAgorot: sum('no_bank'),
    noBankSellers: count('no_bank'),
    belowMinimumAgorot: sum('below_minimum'),
    belowMinimumSellers: count('below_minimum'),
    payableCommissionAgorot: rows.reduce((t, r) => (r.state === 'payable' ? t + r.commissionAgorot : t), 0),
    // Over EVERY seller, not only those with a row here: a seller whose balance is fully settled has
    // no releasable money and so no row, and their past transfers are still money that has left.
    paidOutAgorot: [...totals.values()].reduce((t, v) => t + v.paidOutAgorot, 0),
    commissionSettledAgorot: [...totals.values()].reduce((t, v) => t + v.commissionSettledAgorot, 0),
    adjustmentsAgorot: [...adjustments.values()].reduce((t, v) => t + v, 0),
  };
}

/**
 * Build this period's payouts — the plan above, plus the rows it implies.
 *
 * Everything this used to decide for itself now comes from `planPayouts`, so the figure the owner
 * was shown before the run and the transfers the run actually creates cannot be two answers.
 *
 * `todayISO` is a parameter so the job, a test and a dry run can all be asked about the same day —
 * the same reason `orderHold` takes one.
 */
export async function runPayouts(todayISO: string = businessTodayISO()): Promise<PayoutRunResult> {
  const plan = await planPayouts(todayISO);
  const result: PayoutRunResult = {
    periodKey: plan.periodKey, created: 0, totalAgorot: 0,
    skippedBelowMinimum: 0, skippedNoBank: 0, skippedAlreadyPaid: 0,
  };

  for (const row of plan.rows) {
    // `settled` is counted as below-minimum, which is exactly what this counter has always
    // reported: a seller whose released money has all been sent has a balance of zero, and zero is
    // below the minimum. Kept as one number here so the run's log line does not change meaning;
    // the plan keeps them apart, because a screen has to.
    if (row.state === 'already_paid') { result.skippedAlreadyPaid++; continue; }
    if (row.state === 'below_minimum' || row.state === 'settled') { result.skippedBelowMinimum++; continue; }
    if (row.state === 'no_bank') { result.skippedNoBank++; continue; }

    const payout = await createPayout({
      sellerId: row.sellerId,
      periodKey: plan.periodKey,
      amountAgorot: row.balanceAgorot,
      commissionAgorot: row.commissionAgorot,
      bankSnapshot: row.bank,
      detail: `לתשלום ${formatAgorot(row.balanceAgorot)} · עמלה שנוכתה ${formatAgorot(row.commissionAgorot)}`,
    });
    // Null means the UNIQUE index caught a concurrent run. Not an error — the other run created it.
    if (!payout) { result.skippedAlreadyPaid++; continue; }

    result.created++;
    result.totalAgorot += payout.amountAgorot;

    // ── The platform's own invoice to this seller, for the same period ──
    //
    // Placed here, in the payout run, because this is the moment the three figures exist together
    // and agree with what the seller is about to see on their statement.
    //
    // **The commission invoiced is the commission SETTLED BY THIS PAYOUT** — the increment the plan
    // computed, never the cumulative figure and never commission on the month's orders. Commission
    // on orders would bill a seller for money still sitting in hold, a fee not yet taken arriving
    // before the payout it relates to; the cumulative figure would bill them again for every period
    // that rolled over below the minimum. Invoicing exactly what was deducted from this transfer is
    // the only version that reconciles against the payout beside it.
    //
    // The subscription is included because reaching a payout PROVES a sale happened, which is
    // exactly the trigger `pricing.ts` names for billing to start. ⚠️ Its other half — the 2-month
    // cap that starts billing a seller who has NOT sold — is not here and cannot be: it needs a
    // card on file and a gateway, neither of which exists (GO_LIVE §3). The ad margin is 0 until an
    // ad account is connected (GO_LIVE §2), so its line is present and empty rather than absent.
    //
    // Failure is swallowed: the money is already committed by this point, and a document that could
    // not be planned must not undo a payout. The row is either there or it is in the pending
    // backlog, and `countPendingDocuments()` reports the gap either way.
    await planPlatformInvoice({
      seller: row.seller,
      periodKey: plan.periodKey,
      commissionAgorot: row.commissionAgorot,
      includeSubscription: true,
    }).catch(() => null);
  }

  return result;
}
