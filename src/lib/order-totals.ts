import { sumMoney } from './money.js';

/** The three fields the total is made of — structural on purpose, so the client renderers can pass
 *  their own narrower JSON shape (they never carry the discount's type/value, only `applied`)
 *  instead of each keeping a private total. Widen it and a call site starts computing its own. */
interface StoreSliceAmounts {
  subtotal: number;
  shipping: number;
  discount?: { applied: number };
}

/** What one store's slice of an order actually came to: goods + shipping − the seller's order
 *  discount. **The** definition, and the number every order-facing surface must show — the seller's
 *  order card, the buyer's order history, and the "sort by amount" key all used to compute
 *  `subtotal + shipping` inline and drop the discount, so a discounted order displayed a total
 *  nobody was ever charged, sorted as if it were bigger, and disagreed with the same order's total
 *  right after the seller saved the discount (that one renderer got it right). Fixed 2026-08-02;
 *  `tests/order-total-single-source.test.ts` fails any new inline copy.
 *
 *  Deliberately NOT the same question as `admin-stats.ts#orderNetForStore`, which is REVENUE and so
 *  excludes shipping (the carrier's fee is not the seller's income). Both read the same discount;
 *  they differ only on shipping, and neither may be used for the other's job.
 *
 *  No floor at zero: the discount is written against the subtotal alone (orders API), so a negative
 *  result means a corrupt row, and `reconcile.ts` is what reports that rather than a display helper
 *  bending it back into range. */
export function storeSliceTotal(sub: StoreSliceAmounts | undefined): number {
  if (!sub) return 0;
  return sumMoney([sub.subtotal, sub.shipping, -(sub.discount?.applied ?? 0)]);
}
