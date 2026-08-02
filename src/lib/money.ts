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
 * ⚠️ This is the interim fix, not the end state. The real answer is to store money
 * as integer agorot and never hold a fractional amount at all — that removes the
 * error instead of trimming it. It is deliberately deferred to the DB migration
 * (DB_MIGRATION_PLAN.md), because changing the stored unit is a column-type change
 * and doing it on JSON first would mean migrating the same data twice.
 */

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
