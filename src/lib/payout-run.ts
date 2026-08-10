import { businessTodayISO, businessMonthKey } from './business-day.js';
import { MIN_PAYOUT_AGOROT, PAYOUT_DAY_OF_MONTH } from './payout-schedule.js';
import {
  getReleasableBySeller,
  getPayoutsForSeller,
  getAdjustmentsForSeller,
  createPayout,
  type BankSnapshot,
} from './payouts.js';
import { getSellerById } from './seller-auth.js';
import { planPlatformInvoice } from './invoicing/index.js';

/**
 * The monthly payout run: turn every seller's released balance into a payout row.
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
 * header). "Has this month already been paid" is never a question this code asks; it inserts and
 * reads the affected-row count.
 *
 * ── The three reasons a seller is skipped, all of which accrue rather than forfeit ──
 *   1. Below `MIN_PAYOUT_AGOROT` — a transfer that costs more to send than it moves. Rolls over.
 *   2. No bank details — the seller has never filled them in. Rolls over, and their screen says so.
 *      They are never asked for these at registration (`feedback_seller_form_burden`), so this is a
 *      normal state for a seller's first month, not an error.
 *   3. A carried debt exceeds the balance — a chargeback larger than what is released. Nothing to
 *      send; the debt stays and reduces next month.
 * None of the three loses the seller a shekel, and `terms.astro` says so in those words.
 */

export interface PayoutRunResult {
  /** The period these payouts belong to, 'YYYY-MM' on the business calendar. */
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

/** Is today the day? Compared as the business calendar's day-of-month, never the server's. */
export function isPayoutDay(todayISO: string = businessTodayISO()): boolean {
  return Number(todayISO.slice(8, 10)) === PAYOUT_DAY_OF_MONTH;
}

/** The bank details a transfer needs, or null when the seller has not supplied them.
 *  All four or none: a transfer missing any one of them cannot be made, and a half-filled form
 *  must read as "not ready" rather than produce a payout that will bounce. */
function bankOf(seller: {
  bankCode?: string; bankBranch?: string; bankAccount?: string; bankAccountHolder?: string;
}): BankSnapshot | null {
  const { bankCode, bankBranch, bankAccount, bankAccountHolder } = seller;
  if (!bankCode || !bankBranch || !bankAccount || !bankAccountHolder) return null;
  return { code: bankCode, branch: bankBranch, account: bankAccount, holder: bankAccountHolder };
}

/**
 * Build this period's payouts.
 *
 * `todayISO` is a parameter so the job, a test and a dry run can all be asked about the same day —
 * the same reason `orderHold` takes one.
 */
export async function runPayouts(todayISO: string = businessTodayISO()): Promise<PayoutRunResult> {
  const periodKey = businessMonthKey(new Date(`${todayISO}T12:00:00Z`));
  const result: PayoutRunResult = {
    periodKey, created: 0, totalAgorot: 0,
    skippedBelowMinimum: 0, skippedNoBank: 0, skippedAlreadyPaid: 0,
  };

  const releasable = await getReleasableBySeller(todayISO);

  for (const row of releasable) {
    // Everything already sent, and everything owed against this seller. Read per seller rather than
    // in the aggregate query because both are small per seller (a payout a month, a rare
    // adjustment) and folding them into that GROUP BY would make one wrong join silently
    // under- or over-pay every seller at once.
    const [payouts, adjustments, seller] = await Promise.all([
      getPayoutsForSeller(row.sellerId),
      getAdjustmentsForSeller(row.sellerId),
      getSellerById(row.sellerId),
    ]);
    if (!seller) continue;

    if (payouts.some((p) => p.periodKey === periodKey)) {
      result.skippedAlreadyPaid++;
      continue;
    }

    // `failed` excluded for the same reason `seller-account.ts` excludes it: a bounced transfer is
    // money that came back, and counting it would withhold that amount forever.
    const paidOut = payouts.reduce((sum, p) => (p.status === 'failed' ? sum : sum + p.amountAgorot), 0);
    const adjusted = adjustments.reduce((sum, a) => sum + a.amountAgorot, 0);
    const payable = row.netAgorot - paidOut + adjusted;

    // ── The commission INCREMENT, and why it is not `row.commissionAgorot` ──
    // `getReleasableBySeller` is cumulative: it answers "commission on everything out of hold",
    // which still includes every earlier period, because a balance that sat below the minimum last
    // month is still releasable this month. Harmless in a balance — prior payouts are subtracted
    // above — and NOT harmless on the tax invoice generated below, which would bill the seller a
    // second time for commission they were already invoiced for. So each payout records the slice
    // it settled and the next one subtracts them all. A failed payout is excluded here for the
    // same reason it is excluded from `paidOut`: its commission was never really settled either.
    const commissionInvoiced = payouts.reduce((sum, p) => (p.status === 'failed' ? sum : sum + p.commissionAgorot), 0);
    const commissionThisPeriod = Math.max(0, row.commissionAgorot - commissionInvoiced);

    if (payable < MIN_PAYOUT_AGOROT) { result.skippedBelowMinimum++; continue; }

    const bank = bankOf(seller);
    if (!bank) { result.skippedNoBank++; continue; }

    const payout = await createPayout({
      sellerId: row.sellerId,
      periodKey,
      amountAgorot: payable,
      commissionAgorot: commissionThisPeriod,
      bankSnapshot: bank,
      detail: `released ${row.netAgorot} − paid ${paidOut} ${adjusted >= 0 ? '+' : '−'} adj ${Math.abs(adjusted)}; commission settled ${commissionThisPeriod}`,
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
    // **The commission invoiced is the commission SETTLED BY THIS PAYOUT** — the increment computed
    // above, never the cumulative figure and never commission on the month's orders. Commission on
    // orders would bill a seller for money still sitting in hold, a fee not yet taken arriving
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
      seller,
      periodKey,
      commissionAgorot: commissionThisPeriod,
      includeSubscription: true,
    }).catch(() => null);
  }

  return result;
}
