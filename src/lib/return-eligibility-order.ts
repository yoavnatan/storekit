import { getProductsByIds } from './store-products.js';
import { getCategoriesByStoreId, categoryPath } from './store-categories.js';
import { isProductReturnable } from './return-eligibility.js';
import type { Order } from './orders.js';

/**
 * Which LINES of an order may be returned — the order-level question, asked per item.
 *
 * The exclusion is a property of the product's shelf, not of the shop (`return-eligibility.ts`), so
 * an order can be part returnable: the swimsuit stays, the towel goes back. Answering it once here
 * means the buyer's screen and `/api/returns` cannot reach different conclusions about the same
 * basket, which is the shape every other rule in this mechanism is written to avoid.
 *
 * ── Two reads for the whole order, never one per line ──
 * The products in one batch and the store's category tree in another. An order holds a handful of
 * lines and a query per line is a round trip per line on a click path
 * (AI_INSTRUCTIONS → Scalability).
 *
 * ── A line whose product is gone is RETURNABLE ──
 * `order_items` is a snapshot with no foreign key to the product, deliberately, so a seller may
 * delete a product an order still names. With nothing left to read a shelf from, the exclusion
 * cannot be established — and the default the law sets, and the direction the doubt has to fall, is
 * that it may be returned.
 */
export async function returnableLinePositions(order: Pick<Order, 'items'>, storeId: string): Promise<Set<number>> {
  const ids = [...new Set(order.items.map((i) => i.productId).filter(Boolean))];
  const [products, categories] = await Promise.all([
    ids.length ? getProductsByIds(ids) : Promise.resolve([]),
    getCategoriesByStoreId(storeId),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));

  const allowed = new Set<number>();
  order.items.forEach((item, position) => {
    const product = byId.get(item.productId);
    if (!product) { allowed.add(position); return; }
    const path = product.categoryId ? categoryPath(categories, product.categoryId) : '';
    if (isProductReturnable(path)) allowed.add(position);
  });
  return allowed;
}

/** Nothing in this order may be returned — the only case where the button is withheld entirely. */
export async function orderHasNothingReturnable(order: Pick<Order, 'items'>, storeId: string): Promise<boolean> {
  return (await returnableLinePositions(order, storeId)).size === 0;
}
