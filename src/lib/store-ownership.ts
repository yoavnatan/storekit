// store-ownership — the one place a seller's claim on a store or on a product is settled.
//
// **Why it is a module and not three lines per call site: three lines per call site is what it
// was, and one whole surface simply did not have them (found 2026-08-06).** The no-JS fallback
// POST handlers in `seller/dashboard.astro` — the ones `FormFallbackGuard` deliberately keeps
// alive — trusted the form outright: `add-product` wrote into whatever `storeId` the body named,
// and `edit-product` / `delete-product` acted on whatever `productId` it named. Any signed-in
// seller could therefore rewrite the price and stock of, or delete, any product on the platform,
// and file products into a competitor's catalogue. The `/api/product` twin had the checks all
// along, which is exactly the failure shape this repo has seen before: the rule was remembered in
// the endpoint everyone looks at and forgotten in the fallback nobody does.
//
// The rule itself is the one orders already state (`orders.ts#orderBelongsToStore`): a session
// proves which STORES an account owns, and never which ids it may name. An id is not a permission.
//
// Guarded by `tests/store-ownership.test.ts`, which fails any file under `src/pages` that reaches
// `createProduct` / `updateProduct` / `deleteProduct` without importing this module.

import { getStoresBySellerId, type Store } from './stores.js';
import { getProductById, type StoreProduct } from './store-products.js';

/**
 * The seller's own store with this id, or `null`.
 *
 * A blank id answers `null` rather than falling back to the seller's first store: a save form
 * that lost its `storeId` must fail visibly, not silently overwrite a different shop of theirs.
 */
export async function ownedStore(sellerId: string, storeId: string): Promise<Store | null> {
  if (!sellerId || !storeId) return null;
  return (await getStoresBySellerId(sellerId)).find((s) => s.id === storeId) ?? null;
}

/**
 * A product claim: the product AND the store it lives in, but only when that store is this
 * seller's.
 *
 * The two failure reasons stay apart because the callers answer them differently — a missing
 * product is a 404 and a foreign one is a 403, which is what `/api/product` already returned.
 * Collapsing them would change status codes the dashboard's client reads.
 */
export type ProductClaim =
  | { ok: true; product: StoreProduct; store: Store }
  | { ok: false; reason: 'not-found' | 'not-owned' };

export async function ownedProduct(sellerId: string, productId: string): Promise<ProductClaim> {
  if (!productId) return { ok: false, reason: 'not-found' };
  const product = await getProductById(productId);
  if (!product) return { ok: false, reason: 'not-found' };
  const store = await ownedStore(sellerId, product.storeId);
  return store ? { ok: true, product, store } : { ok: false, reason: 'not-owned' };
}
