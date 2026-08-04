/**
 * A product's shipping weight, in whole grams — one definition of what a valid one is.
 *
 * The field exists before the thing that will price it. Sendit quotes a parcel on address + weight
 * (GO_LIVE_CHECKLIST.md §5), so the day that integration is connected, every product without a
 * weight is a product that cannot be quoted — and a seller with a catalogue of dozens of items is
 * being asked to revisit all of them at the worst possible moment. Collected from today, the
 * catalogue fills in as it is edited. Until then it already pays for itself in the ad feed, where
 * `shipping_weight` is a real Merchant Center attribute.
 *
 * **Absent is not zero, and the distinction is the whole reason this module exists.** A zero-gram
 * parcel is a carrier quote of ₪0, which a carrier will cheerfully return; an absent weight is a
 * question the seller has not answered. Both the column (NULL, `migrations/0011_product_weight.sql`)
 * and every read side keep them apart, so nothing may "helpfully" default one to the other.
 */

/**
 * The ceiling, and why there is one at all.
 *
 * 100kg is far above anything an Israeli parcel carrier will take (Sendit's own limit is an order
 * of magnitude lower) and far below the `int` column's. It exists to catch the mistake the unit
 * invites — a seller typing 2.5 for "2.5 kg" is handled by the parser, but one typing 2500000
 * because they were thinking in milligrams is not, and a silently stored nonsense weight becomes a
 * nonsense shipping quote to a real buyer later. Refusing it at the form is a sentence the seller
 * can act on; refusing it at the carrier is a failed checkout.
 */
export const MAX_WEIGHT_GRAMS = 100_000;

/**
 * Whatever a form or an API body carried → grams, or `undefined` for "not stated".
 *
 * Rounds rather than rejects a fraction: `0.5` in a grams field is someone thinking in kilograms,
 * and 1g is a truer answer than an error message. Anything at or below zero, non-numeric, or over
 * the ceiling comes back `undefined` — the caller stores nothing, which is the one state that
 * never lies about the parcel.
 */
export function parseWeightGrams(input: unknown): number | undefined {
  if (input === null || input === undefined || input === '') return undefined;
  const grams = Math.round(Number(input));
  if (!Number.isFinite(grams) || grams <= 0 || grams > MAX_WEIGHT_GRAMS) return undefined;
  return grams;
}

/**
 * The Merchant Center / Meta catalog value: `"<number> <unit>"`, unit in the fixed English
 * vocabulary Google accepts (`g`, `kg`, `oz`, `lb`) — a Hebrew unit here is a rejected item, not a
 * localised one. Empty string when unstated, which is how the feed builder already omits an
 * attribute; `"0 g"` would be worse than silence, since Merchant Center turns this into a shipping
 * estimate and a zero-gram parcel is a delivery price the checkout would then contradict.
 */
export function feedShippingWeight(grams: number | undefined): string {
  return grams ? `${grams} g` : '';
}
