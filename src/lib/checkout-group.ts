/**
 * What makes several order rows ONE purchase.
 *
 * A cart spanning N stores becomes N rows in `orders` — deliberately, so each seller owns an
 * isolated order they can fulfil, cancel and annotate without touching anyone else's slice. That is
 * right for the seller and wrong for everybody looking at the purchase from outside it: the buyer
 * pressed "buy" once, one charge left their card, and the admin asking "what did this person order"
 * means the whole thing, not one fifth of it.
 *
 * The rule lived inline in `buyer-purchases.ts` and is now here because the admin Orders tab needs
 * the SAME key, and — the part that actually forced the extraction — needs it in SQL as well as in
 * JS, since the page of orders is paginated by the database. Two spellings of one rule is exactly
 * the arrangement that drifts; both spellings are in this file, next to each other, so a change to
 * one is a visible omission in the other.
 *
 * **Why the key pairs the checkout ref with the payment ref.** `checkoutRef` is eight hex
 * characters — plenty for a human-quotable order number, thin for a key that decides which rows
 * share a TOTAL. The payment ref is identical across the slices of one charge and different between
 * charges, so pairing them means two unrelated purchases cannot merge into one card even if their
 * short refs collide. Against today's mock provider it adds nothing (its ref is derived from the
 * checkout ref); against a real one it is the whole guarantee, which is why it goes in before there
 * is a real one.
 *
 * A row with no `checkoutRef` is its own purchase, keyed by its id. Nothing writes such a row today,
 * but rows predate the field and they must render as they always did rather than collapsing into
 * one enormous "purchase" of everything that lacks a ref.
 */

/** The JS half. `order` is anything carrying the three fields, so callers can pass a full `Order`
 *  or a projection without this module learning what an order is. */
export function checkoutGroupKey(order: { id: string; checkoutRef?: string; paymentRef?: string }): string {
  return order.checkoutRef ? `${order.checkoutRef}|${order.paymentRef ?? ''}` : order.id;
}

/**
 * The SQL half — the same expression, over an `orders` row aliased `o`.
 *
 * `COALESCE(o.checkout_ref, '') <> ''` rather than `IS NOT NULL`: the column is nullable AND the
 * writer passes `input.checkoutRef || null`, so an empty string is not supposed to reach it — and
 * "not supposed to" is not a thing a grouping key may rely on. An empty ref must fall through to
 * the id, exactly as the JS `order.checkoutRef ?` test does for `''`.
 */
export const CHECKOUT_GROUP_KEY_SQL = `
  CASE WHEN COALESCE(o.checkout_ref, '') <> ''
       THEN o.checkout_ref || '|' || COALESCE(o.payment_ref, '')
       ELSE o.id::text
  END`;
