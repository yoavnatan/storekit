import { getLedgerAccrual, getLedgerMovement } from './payouts.js';
import { getSubscriptionAccrual } from './seller-auth.js';
import { buildPlatformRevenue } from './platform-revenue.js';
import { buildPlatformStatement, type PlatformStatement, type StatementPeriod } from './platform-statement.js';

/**
 * The statement's five reads, as ONE wave.
 *
 * Its own module rather than lines in the admin page or the API route, because BOTH need it and a
 * second assembly of the same five queries is a second document that can disagree with the first —
 * the screen and the downloaded file would then be two answers to one question, which is the whole
 * failure this report exists to prevent. `/api/admin/statement` and `admin/index.astro` call this.
 *
 * **Four of the five are the same two functions asked about two windows**: the period, and
 * everything before it. That is what produces an opening balance which is guaranteed to be the same
 * arithmetic as the closing one (`platform-statement.ts`), instead of a separately-derived figure
 * that happens to agree today.
 *
 * The subscription line goes through `buildPlatformRevenue` rather than being summed here, so the
 * pro-rata rule keeps one home. Its other two inputs are deliberately inert: commission is passed
 * as 0 because the statement takes that figure from `getLedgerAccrual` (the same query the balances
 * are computed from — one definition, not two), and the campaign list is empty because ad revenue
 * is excluded from this document on purpose. The header of `platform-statement.ts` says why.
 */
export async function loadPlatformStatement(
  period: StatementPeriod,
  generatedAtISO: string,
): Promise<PlatformStatement> {
  const before = { from: null, to: previousDayISO(period.fromISO) };
  const [accrued, movement, beforeAccrued, beforeMovement, tiers] = await Promise.all([
    getLedgerAccrual({ from: period.fromISO, to: period.toISO }),
    getLedgerMovement({ from: period.fromISO, to: period.toISO }),
    getLedgerAccrual(before),
    getLedgerMovement(before),
    getSubscriptionAccrual(period.fromISO, period.toISO),
  ]);
  const revenue = buildPlatformRevenue(0, 0, tiers, [], period.fromISO, period.toISO);
  return buildPlatformStatement({
    period,
    generatedAtISO,
    accrued,
    movement,
    before: { accrued: beforeAccrued, movement: beforeMovement },
    revenue,
  });
}

/**
 * The day before a `YYYY-MM-DD`, by string arithmetic.
 *
 * `new Date(iso)` parses as UTC and `getDate() - 1` then reads the result in the RUNTIME's zone, so
 * on a production server in UTC the 1st of a month would step back to the 30th and on a machine east
 * of it to the 31st — the off-by-one-day `business-day.ts` exists to end. The opening balance is
 * bounded by this date, so getting it wrong moves one day's sales from one month's statement into
 * the other's, in a document handed to an accountant.
 */
function previousDayISO(iso: string): string {
  const day = Number(iso.slice(8, 10));
  if (day > 1) return `${iso.slice(0, 8)}${String(day - 1).padStart(2, '0')}`;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const lengths = [31, (prevYear % 4 === 0 && prevYear % 100 !== 0) || prevYear % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(lengths[prevMonth - 1]).padStart(2, '0')}`;
}
