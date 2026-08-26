/**
 * What PayMe take for us on a sale — the arithmetic, with no network anywhere near it.
 *
 * These two functions lived in `payment-payme.ts` beside the calls that use them, under a heading
 * saying they are "pure, so they are testable without a network". They moved here on 2026-08-26 for
 * a reason that heading did not anticipate: **a second caller appeared that `payment-payme.ts`
 * cannot export to.** `payme-demo.ts` answers PayMe's own calls locally, so `payment-payme.ts`
 * imports IT, and an import back the other way is a cycle.
 *
 * The demo therefore had a choice between a cycle and its own copy of the fee formula — and it
 * wrote the copy. That is the exact defect `marketFeeTotalAgorot`'s own comment records having been
 * caught once already ("a hand-rolled copy is two definitions of one number, and the day they round
 * differently our predicted commission and the seller's reported commission disagree by an agora
 * with no way to tell which is right"), reintroduced by the one caller whose whole job is to answer
 * exactly as the real gateway would. A demonstration computing the fee differently from production
 * is a demonstration of different software.
 *
 * A third module both can import is the ordinary answer to a cycle, and here it is also the better
 * shape on its own terms: these are money RULES, and money rules in this repo live in one place per
 * rule (`lib/money.ts`, `lib/pricing.ts`, `lib/order-status-rules.ts`). `payment-payme.ts` re-exports
 * both names, so every existing call site is unchanged and the tree scan in
 * `tests/money-guards.test.ts` still sees them where it expects.
 */
import { agorotToDecimalString } from './money.js';
import { commissionOnAgorot } from './pricing.js';

/**
 * Agorot → the shekel NUMBER `market_fee_fixed` expects.
 *
 * `agorotToDecimalString` and not a division, deliberately: `1015 / 100` is `10.149999999999999`
 * in binary floating point, and a JSON body carrying fifteen decimal places of a fee is a
 * conversation with PayMe's support nobody wants to have. The string is exact, and `Number` of an
 * exact two-decimal string is the nearest double to it, which is the best any JSON number can be.
 */
export function marketFeeFixedShekels(agorot: number): number {
  return Number(agorotToDecimalString(agorot));
}

/**
 * What PayMe will actually take for us on a sale, in agorot.
 *
 * The percentage applies to `sale_price`; the fixed amount is added on top. Measured exactly:
 * `sale_price 5000` + `market_fee 12` + `market_fee_fixed 15` → `sale_market_fee_total: 2100`.
 * Rounded to the agora once, at the end, for the same reason `pricing.ts#commissionOnAgorot`
 * exists — so our figure and theirs cannot disagree by a rounding.
 */
export function marketFeeTotalAgorot(input: { salePriceAgorot: number; marketFeePercent: number; marketFeeFixedAgorot?: number }): number {
  // `commissionOnAgorot` and not `Math.round(price * pct / 100)` written out again, even though
  // that is all it is. It is `pricing.ts`'s definition of "the platform's cut of a figure held in
  // agorot", and the percentage PayMe apply here IS that cut — so a hand-rolled copy is two
  // definitions of one number, and the day they round differently our predicted commission and the
  // seller's reported commission disagree by an agora with no way to tell which is right. Written
  // out once, caught reviewing this diff.
  return commissionOnAgorot(input.salePriceAgorot, input.marketFeePercent) + (input.marketFeeFixedAgorot ?? 0);
}
