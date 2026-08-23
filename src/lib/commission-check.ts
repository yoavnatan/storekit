/**
 * What we told the seller we take, against what PayMe actually took.
 *
 * ── The gap (area audit, row 13) ──
 * Two numbers are computed independently and nothing had ever compared them:
 *
 *  · **Ours.** `pricing.ts` gives the seller's tier a commission percent; `commissionOnAgorot`
 *    turns it into an amount, and that amount is what every seller-facing report subtracts and what
 *    the platform's own revenue is built from.
 *  · **Theirs.** The commission is taken INSIDE the transaction — PayMe deduct `market_fee` as the
 *    charge happens and pay us monthly (agreement §33) — and `generate-sale` answers with
 *    `sale_market_fee_total`, their figure for what they actually kept.
 *
 * Nothing read the second one. It came back on every capture and was dropped, so a disagreement
 * between the rate on a seller's dashboard and the money really deducted from his sale would have
 * been invisible on both sides: his reports would show one number, his PayMe statement another, and
 * the first person to notice would be him.
 *
 * ── Why a mismatch is possible at all, which is the reason this is worth the code ──
 * The percent is sent per sale (`payment-split.ts` passes the tier's rate rather than relying on the
 * merchant's stored default), so the two SHOULD agree. They can stop agreeing without anyone
 * touching this repository: PayMe hold a default fee per merchant and `create-seller` sets it once,
 * a fee can be changed at their end, and a tier change here that a future code path forgets to send
 * would silently fall back to whatever they have stored. Each of those is a real percentage of real
 * money, deducted quietly.
 *
 * ── The tolerance is one agora, and it is a rounding allowance rather than a threshold ──
 * Both sides round a percentage of an integer amount to whole agorot and neither publishes which
 * way. One agora is the largest a rounding difference can be; anything above it is a different
 * NUMBER, not a different rounding. It is deliberately not "half a percent" — a threshold in
 * percent would hide exactly the small systematic drift this exists to catch.
 *
 * Pure: takes two amounts, returns the verdict. The reporting of it belongs to the caller.
 */

import { formatAgorot } from './money.js';

/** The largest difference two correct roundings of the same percentage can produce. */
export const COMMISSION_ROUNDING_TOLERANCE_AGOROT = 1;

export interface CommissionMismatch {
  /** What our own pricing says this sale's commission is, agorot. */
  expectedAgorot: number;
  /** What PayMe report having taken, agorot — `sale_market_fee_total`. */
  actualAgorot: number;
  /** Theirs minus ours. Positive means they took MORE than we told the seller. */
  deltaAgorot: number;
}

/**
 * Do the two figures agree?
 *
 * `null` when they do, or when PayMe did not report one — **an absent figure is not a mismatch**.
 * Their response is not guaranteed to carry it, and turning "they said nothing" into "they took the
 * wrong amount" would fill the log with a finding about our own reading rather than about money.
 */
export function commissionMismatch(
  expectedAgorot: number,
  actualAgorot: number | undefined,
): CommissionMismatch | null {
  if (actualAgorot === undefined || !Number.isFinite(actualAgorot)) return null;
  const delta = Math.round(actualAgorot) - Math.round(expectedAgorot);
  if (Math.abs(delta) <= COMMISSION_ROUNDING_TOLERANCE_AGOROT) return null;
  return { expectedAgorot: Math.round(expectedAgorot), actualAgorot: Math.round(actualAgorot), deltaAgorot: delta };
}

/**
 * One line about a mismatch, for the money journal.
 *
 * Written here rather than at the call site because the journal is read months later by whoever is
 * asking where a seller's money went, and the sentence has to carry the three numbers that answer
 * it. In Hebrew, like every other row on that screen.
 *
 * **Every figure goes through `formatAgorot`.** The comparison above is in agorot because that is
 * the unit money is compared in; a SENTENCE is where the pipeline ends and the screen begins
 * (`lib/money.ts`), and a raw `120` beside a shekel sign reads as ₪120 rather than ₪1.20. The
 * one-agora tolerance means the smallest number this ever prints is ₪0.02, which is exact and
 * unambiguous — which is the point.
 */
export function commissionMismatchDetail(m: CommissionMismatch, storeSlug: string, paymeSaleId: string): string {
  const direction = m.deltaAgorot > 0 ? 'יותר' : 'פחות';
  return `אי-התאמה בעמלה · חנות ${storeSlug} · אסמכתה ${paymeSaleId} · לפי המסלול שלנו ${formatAgorot(m.expectedAgorot)}, PayMe גבו ${formatAgorot(m.actualAgorot)} — ${direction} ב-${formatAgorot(Math.abs(m.deltaAgorot))}.`;
}
