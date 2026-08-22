import { AD_METRICS_ARE_MOCK } from './ad-metrics.js';
import { getLedgerAccrual } from './platform-accrual.js';
import { getSubscriptionAccrual } from './seller-auth.js';
import { buildPlatformRevenue } from './platform-revenue.js';
import { buildPlatformStatement, type PlatformStatement, type StatementPeriod } from './platform-statement.js';

/**
 * The statement's two reads, as ONE wave.
 *
 * Its own module rather than lines in the admin page or the API route, because BOTH need it and a
 * second assembly of the same queries is a second document that can disagree with the first — the
 * screen and the downloaded file would then be two answers to one question, which is the whole
 * failure this report exists to prevent. `/api/admin/statement` and `admin/index.astro` call this.
 *
 * **It was six reads until 2026-08-21.** Four of them served the cash half of the document — what we
 * transferred to sellers in the period, what we had transferred before it, and the opening balance
 * chained from both — and the sixth was the next payout run's commission. None of those exists under
 * the split model: no money of a seller's ever reaches us, so there is no balance to open, close or
 * forecast (`platform-statement.ts` carries the argument). What is left is what the period earned.
 *
 * The subscription line goes through `buildPlatformRevenue` rather than being summed here, so the
 * pro-rata rule keeps one home. Its other two inputs are deliberately inert: commission is passed
 * as 0 because the statement takes that figure from `getLedgerAccrual` (one definition, not two),
 * and the campaign list is empty because ad reporting is a mock and this document will not state a
 * made-up figure. The header of `platform-statement.ts` says why, and `AD_METRICS_ARE_MOCK` says
 * what to change on the day it stops being one.
 */
export async function loadPlatformStatement(
  period: StatementPeriod,
  generatedAtISO: string,
): Promise<PlatformStatement> {
  const [accrued, tiers] = await Promise.all([
    getLedgerAccrual({ from: period.fromISO, to: period.toISO }),
    getSubscriptionAccrual(period.fromISO, period.toISO),
  ]);
  const revenue = buildPlatformRevenue(0, 0, tiers, [], period.fromISO, period.toISO);
  return buildPlatformStatement({
    period,
    generatedAtISO,
    accrued,
    revenue,
    // `null`, not `revenue.adMarginAgorot` — the campaign list above is empty on purpose, so that
    // field is 0 here and a 0 on this document would read as "we earned nothing from campaigns"
    // rather than "no ad account is connected yet". When AD_METRICS_ARE_MOCK flips, this line takes
    // the real margin and the campaign list has to be loaded above for it to mean anything.
    adMarginAgorot: AD_METRICS_ARE_MOCK ? null : revenue.adMarginAgorot,
  });
}
