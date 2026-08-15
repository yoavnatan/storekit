import { firstRow } from './db.js';
import { FUNDS_RECEIVED_PAYMENT_STATUSES } from './order-status-rules.js';
import { BUSINESS_TIMEZONE, businessTodayISO } from './business-day.js';
import { getLedgerMovement } from './payouts.js';

/**
 * How close the platform is to the licensing threshold it currently sits under.
 *
 * ── Why this exists, and why it is a SCREEN rather than a note in a document ──
 * Collecting a buyer's money and paying it on to a seller is a payment service under
 * `חוק הסדרת העיסוק בשירותי תשלום וייזום תשלום, תשפ״ג-2023`, and it requires a licence from רשות
 * ניירות ערך. The platform operates instead under the size exemption in `תקנות … (פטור מחובת
 * רישוי), תשפ״ד-2024`, which holds only while the **monthly average** of funds received and of
 * funds transferred each stay under the ceiling below (checked against the regulations 2026-08-16;
 * the commercial-agent exclusion that PSD2 art. 3(b) grants in Europe has NO Israeli twin, so the
 * size test is the whole of the cover).
 *
 * A threshold nobody can see is a threshold crossed in hindsight. Applying for the licence takes
 * months, so the number that matters is not "have we passed it" but "how much room is left", which
 * is why `CEILING_WATCH_PERCENT` sits far below 100.
 *
 * ── ⚠️ What is NOT verified, and must not be presented as if it were ──
 * The regulations say "monthly average" and this module reads that as *a trailing window divided by
 * the months it actually covers*. The averaging window the regulator intends is not stated in the
 * text that was read, and nobody has asked them. Both figures here are therefore a MEASUREMENT the
 * owner can act on, not a compliance determination — the copy on the tile says so, and the decision
 * that follows from a high reading is "talk to a עו״ד now", never "we are still fine".
 */

/**
 * The exemption ceiling, in agorot: 5,254,680 ₪.
 *
 * **Index-linked, and that is the trap in this constant.** Regulation 6 adjusts it annually against
 * the CPI, so a number hard-coded here drifts DOWNWARD in real terms and this tile then reports
 * more headroom than exists — the one direction of error that matters. It is stamped with the
 * figure's date for exactly that reason, and `⚠️ owner` because re-reading the published figure is
 * not something code can do for itself.
 *
 * ⚠️ As published for 2024 and read on 2026-08-16. Two years unindexed; re-check before relying on
 * the last few percent of headroom.
 */
export const LICENCE_CEILING_AGOROT = 525_468_000;

/** Where the tile stops being informational. Deliberately low: a licence application is measured in
 *  months, so the useful warning arrives while there is still a year of runway, not at 95%. */
export const CEILING_WATCH_PERCENT = 50;
/** Where it becomes an action. Above this, the application has to be started, not planned. */
export const CEILING_ACT_PERCENT = 70;

/** Trailing window the average is taken over. A year smooths a seasonal peak — the ceiling is an
 *  average rather than a maximum, so one big month is not the question being asked. */
export const CEILING_WINDOW_MONTHS = 12;

export type CeilingLevel = 'ok' | 'watch' | 'act';

export interface CeilingLeg {
  /** Total over the window. */
  totalAgorot: number;
  /** That total divided by the months it covers — the figure the exemption is written against. */
  monthlyAverageAgorot: number;
  /** Of `LICENCE_CEILING_AGOROT`, rounded to one decimal. */
  percent: number;
}

export interface LicenceCeiling {
  /** Money that ARRIVED from buyers: the full charge, shipping included. */
  received: CeilingLeg;
  /** Money that LEFT to sellers. */
  transferred: CeilingLeg;
  /** The higher of the two percentages — the exemption fails on whichever leg breaches first. */
  percent: number;
  level: CeilingLevel;
  /** Months the average was actually divided by. Below `CEILING_WINDOW_MONTHS` on a young platform,
   *  and shown, because "₪X per month over 2 months" and "over 12" are different claims. */
  months: number;
  fromISO: string;
  toISO: string;
}

const pct = (part: number, whole: number): number => Math.round((part / whole) * 1000) / 10;

/**
 * Months the window really covers — fractional, and never zero.
 *
 * Two ways of getting this wrong, and **both understate the average, which is the one direction
 * that matters**: this figure decides whether anybody goes and applies for a licence, so reading
 * low means operating past the exemption without knowing.
 *
 *   1. Dividing by a fixed 12 on a platform three months old reports a third of the true monthly
 *      rate. Counting from the first month money actually arrived fixes that.
 *   2. **Counting the CURRENT month as a whole one.** On the 2nd of a month that month contributes
 *      two days of receipts and a full month to the divisor, so the reading collapses at every
 *      month boundary and climbs back through the month — a sawtooth on a compliance gauge, always
 *      biased low. So the current month counts as the fraction of it that has elapsed.
 *
 * The result is not a whole number and is not meant to be: `months` is a divisor the tile states
 * out loud, because "₪X a month over 1.5 months" and "over 12" are different claims.
 */
function monthsElapsed(firstMonthISO: string, toISO: string): number {
  const [fy, fm] = firstMonthISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  const whole = ((ty ?? 0) - (fy ?? 0)) * 12 + ((tm ?? 0) - (fm ?? 0));
  // Days in the current month, from the calendar rather than a 30/31 table — February exists.
  const inMonth = new Date(Date.UTC(ty ?? 1970, tm ?? 1, 0)).getUTCDate();
  return Math.max(1 / inMonth, whole + (td ?? 1) / inMonth);
}

/**
 * Funds received from buyers in a window, and the first month any arrived.
 *
 * **`total_agorot`, not the revenue figure the rest of the platform reports.** Three deliberate
 * differences, each of which would understate the number the regulator asks about:
 *   1. It is the whole charge — shipping included. The buyer's card was debited for that, whoever
 *      the money is ultimately for.
 *   2. It is bucketed by `paid_at`, not `created_at`. Every other report on this platform buckets
 *      by the sale (`order-reporting.ts`), and rightly; this one is about money moving, and the
 *      regulation is written about receipts. **`paid_at` may be NULL on a genuinely charged
 *      order** — `payout-hold.ts` has a branch for exactly that — so it falls back to `created_at`
 *      rather than dropping the row. The hold refuses to date such an order because there the safe
 *      direction is to keep holding; here the safe direction is the opposite, and a row silently
 *      missing from a ceiling is the failure this whole module exists to prevent.
 *   3. It counts orders that were later CANCELLED. `moneyWasTaken` rather than `countsAsRevenue`,
 *      because the cash did arrive and pass through — a refund is a second movement, not an
 *      un-happening of the first. This is the one place on the platform where a cancelled paid
 *      order must still be counted, and it is why the status table has both columns.
 */
async function receivedInWindow(fromISO: string, toISO: string) {
  const found = await firstRow<{ total: string | number; first_month: string | null }>(
    `SELECT COALESCE(SUM(total_agorot), 0)                                             AS total,
            MIN(to_char((COALESCE(paid_at, created_at) AT TIME ZONE $4), 'YYYY-MM'))   AS first_month
       FROM orders
      WHERE payment_status = ANY($1::text[])
        AND (COALESCE(paid_at, created_at) AT TIME ZONE $4)::date >= $2::date
        AND (COALESCE(paid_at, created_at) AT TIME ZONE $4)::date <= $3::date`,
    [FUNDS_RECEIVED_PAYMENT_STATUSES, fromISO, toISO, BUSINESS_TIMEZONE],
  );
  return { totalAgorot: Number(found?.total ?? 0), firstMonth: found?.first_month ?? null };
}

/** First day of the month `months - 1` before `toISO`'s month, on the business calendar. */
function windowStartISO(toISO: string, months: number): string {
  const [y, m] = toISO.split('-').map(Number);
  const zero = ((y ?? 1970) * 12 + ((m ?? 1) - 1)) - (months - 1);
  return `${String(Math.floor(zero / 12)).padStart(4, '0')}-${String((zero % 12) + 1).padStart(2, '0')}-01`;
}

/**
 * Both legs of the exemption test, as one reading.
 *
 * Two queries, both plain aggregates — this is an admin tile, so it may not cost a scan per seller
 * (`feedback_scalability`). The transferred leg reuses `getLedgerMovement`, which is already the
 * platform's one answer to "what left", rather than summing `seller_payouts` a second time here.
 */
export async function getLicenceCeiling(
  todayISO: string = businessTodayISO(),
  windowMonths: number = CEILING_WINDOW_MONTHS,
): Promise<LicenceCeiling> {
  const fromISO = windowStartISO(todayISO, windowMonths);
  const [inbound, movement] = await Promise.all([
    receivedInWindow(fromISO, todayISO),
    getLedgerMovement({ from: fromISO, to: todayISO }),
  ]);

  // ── ONE divisor for both legs, and the approximation is named rather than hidden ──
  // It comes from the first month money ARRIVED, so a platform two months old is not divided by 12.
  // Payouts necessarily start later than receipts — nothing can be transferred before it is
  // collected, and the hold delays it further — so the transferred leg is divided by a slightly
  // longer history than its own, and reads slightly low. That is bounded and it decays: the gap is
  // at most the hold, so it can only matter in the platform's first weeks, when both legs are
  // orders of magnitude below the ceiling. Two different denominators on one card, each correct for
  // its own row and neither comparable to the other, is the worse trade.
  const months = monthsElapsed(inbound.firstMonth ? `${inbound.firstMonth}-01` : fromISO, todayISO);
  const leg = (totalAgorot: number): CeilingLeg => {
    const monthlyAverageAgorot = Math.round(totalAgorot / months);
    return { totalAgorot, monthlyAverageAgorot, percent: pct(monthlyAverageAgorot, LICENCE_CEILING_AGOROT) };
  };

  const received = leg(inbound.totalAgorot);
  const transferred = leg(movement.paidOutAgorot);
  const percent = Math.max(received.percent, transferred.percent);
  return {
    received,
    transferred,
    percent,
    level: percent >= CEILING_ACT_PERCENT ? 'act' : percent >= CEILING_WATCH_PERCENT ? 'watch' : 'ok',
    months,
    fromISO,
    toISO: todayISO,
  };
}
