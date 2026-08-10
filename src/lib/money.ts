/**
 * Money arithmetic — the one place amounts get rounded.
 *
 * Amounts are JS numbers (ILS, 2 decimals) held in JSON. That means every
 * `+=` over prices accumulates binary-float error: `19.99 * 3` is
 * 59.97000000000001, and a subtotal built by summing line items carries that
 * tail into `totalAmount`, into the reports built on top of it, and into
 * anything that exports or compares those numbers.
 *
 * `formatPrice` hides it on screen (it formats to 2 decimals), which is exactly
 * why it is worth fixing at the source instead: the raw number is what a CSV
 * export writes, what a sort compares, what a reconciliation check tests for
 * equality, and — once the split-payment provider is wired — what gets handed to
 * a processor that will not accept 12 decimal places.
 *
 * The rule: any amount that is SUMMED, or that leaves this codebase (stored on an
 * order, returned from an API, rendered, charged), goes through `roundMoney`.
 *
 * ⚠️ **This is the interim fix for what is LEFT, and what is left is shrinking.** The real answer
 * is to hold money as integer agorot and never carry a fractional amount at all — that removes the
 * error instead of trimming it. As of the `orders` migration the whole money PIPELINE has done
 * that: order totals, line prices, per-store subtotals, discounts as applied, the journal's
 * amounts, and every revenue/GMV/commission figure summed from them are integers now, and none of
 * them passes through `roundMoney` any more, because integers add up exactly.
 *
 * What still runs on ILS floats is the two ends the unit was never the point of — the numbers a
 * seller TYPES (a product price, a discount value, an ad budget) and the numbers a person READS.
 * Those still round, here, on the way in and out. The remaining `roundMoney` call sites are ad
 * spend and product pricing; they follow when their own modules move.
 */
import { formatPrice } from '../config/store.config.js';

/** An ILS amount rounded to agorot. The `+ Number.EPSILON` nudge keeps values that
 *  land a hair BELOW a half-agora (0.145 stored as 0.1449999…) from rounding down. */
export function roundMoney(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Sum of amounts, rounded once at the end — for building a total out of line items. */
export function sumMoney(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) total += Number.isFinite(a) ? a : 0;
  return roundMoney(total);
}

/** `percent`% of `amount`, rounded to agorot. The one definition of a percentage cut
 *  (platform commission, a percent discount), so two call sites can't round differently. */
export function percentOf(amount: number, percent: number): number {
  return roundMoney((amount * percent) / 100);
}

/**
 * ILS → the integer agorot a `*_agorot bigint` column holds (§7.7), and back.
 *
 * **This is the boundary, and it is deliberately only the boundary.** The columns store integers
 * because that is where the rounding error stops accumulating; the application still passes ILS
 * numbers around, because flipping the unit everywhere — every price render, cart line, discount,
 * feed field and order total — is a change to make once, with `orders`, not one module at a time.
 * So a module that has moved to Postgres converts on read and on write and hands the rest of the
 * app exactly the number it handed it before.
 *
 * `toAgorot` rounds by `roundMoney`'s rule, EPSILON nudge included, because the two must agree to
 * the agora: `scripts/lib/db-import.mjs` imported the existing catalog with that rule, and a write
 * that rounded the other way would move a price by a shekel per hundred on the first save.
 */
export function toAgorot(ils: number): number {
  const n = Number(ils);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) : 0;
}

export function fromAgorot(agorot: number): number {
  const n = Number(agorot);
  return Number.isFinite(n) ? n / 100 : 0;
}

/**
 * Split an integer agorot amount across `weights` so the PARTS SUM EXACTLY TO THE WHOLE.
 *
 * The case it was written for: an order carries ONE discount, against the order's subtotal, but a
 * per-product report has to say what each product earned. Attributing the discount by
 * `Math.round(lineGross * discount / subtotal)` per line is the obvious move and it is wrong —
 * three lines of 33.33% each round to a total that is an agora short or an agora over, so the
 * product report and the sales report disagree about the same day's takings by small, unexplainable
 * amounts. That is precisely the class `tests/reporting-invariants.test.ts` exists to catch.
 *
 * Largest-remainder: floor every share, then hand the leftover agorot out one at a time to the
 * lines with the biggest discarded fraction. Ties go to the earlier line, so the split is
 * deterministic — a report run twice must not move a number.
 *
 * A zero total, an empty list, or weights summing to zero all give zeros: with nothing to weigh
 * by, there is no defensible split, and spreading it evenly would invent one.
 */
export function allocateAgorot(totalAgorot: number, weights: readonly number[]): number[] {
  const total = Math.trunc(Number(totalAgorot)) || 0;
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return safe.map(() => 0);

  const exact = safe.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) parts[order[k % order.length].i]++;
  return parts;
}

/**
 * An agorot amount, rendered.
 *
 * **This is where the money pipeline ends and the screen begins**, and it exists as its own name
 * so that boundary is greppable. Since `orders` moved (DB_MIGRATION_PLAN.md §8), every amount that
 * is stored, summed, compared or journalled is an integer number of agorot; every amount that is
 * shown to a person is ILS. A bare `formatPrice(order.totalAgorot)` would print 27151 ₪ for a
 * 271.51 ₪ order — right shape, no type error, off by a hundred — so the two units do not share a
 * formatter. `formatPrice` still takes ILS, for the prices that are still ILS (a product's price
 * as the seller typed it, a shipping rate from config).
 */
export function formatAgorot(agorot: number): string {
  return formatPrice(fromAgorot(agorot));
}
