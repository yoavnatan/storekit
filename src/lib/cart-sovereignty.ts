/**
 * Store sovereignty — where the store the shopper is currently inside sits in a list of carts.
 *
 * It is one rule ("that store comes first, the rest keep their order") and it is now read in two
 * places that must agree: the cart drawer, which floats it above a "מחנויות אחרות" heading, and the
 * checkout page, which additionally starts it — and only it — selected. They were written apart and
 * that is precisely the shape this repo keeps getting bitten by, so the comparator lives here and
 * `tests/cart-sovereignty.test.ts` fails if either hand-rolls it again.
 *
 * WHICH store is "current" is not the same question in both places, and the caller answers it:
 *  - inside a store, it is `<body data-store-slug>` (server-resolved by BaseLayout — reliable on
 *    custom domains, where the path carries no slug at all);
 *  - on `/checkout`, there is no store context at all (it renders with `storeMode` but no slug), so
 *    the `?store=` parameter the shopper arrived with is the only carrier of where they came from.
 */

/**
 * `carts` with `currentSlug`'s cart moved to the front, everything else in its original order.
 * Returns a new array — the input is never mutated, so a caller can keep rendering from the
 * unsorted list it already holds.
 *
 * Stable by construction rather than by relying on `Array.prototype.sort` being stable: a
 * comparator that returns -1 for "a is current" and 1 for "b is current" is inconsistent when both
 * are (it claims a < b AND b < a), which is undefined behaviour rather than a no-op. Slugs are
 * unique per cart today, so it never fired — but the partition below cannot express the bug at all.
 */
export function sortCurrentStoreFirst<T extends { storeSlug: string }>(
  carts: readonly T[],
  currentSlug: string | null | undefined,
): T[] {
  if (!currentSlug) return [...carts];
  const current: T[] = [];
  const others: T[] = [];
  for (const cart of carts) (cart.storeSlug === currentSlug ? current : others).push(cart);
  return [...current, ...others];
}
