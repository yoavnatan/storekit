import type { StoreProduct } from './store-products.js';
import { productEditRev } from './record-rev.js';

/**
 * One product as the seller dashboard's Products table needs it — the shape the edit row is built
 * from, wherever the row is built.
 *
 * It exists because there are now two producers of exactly this object and they must not drift:
 * `/api/seller/products` (every filter, sort and page change) and `seller/dashboard.astro`'s own
 * first paint, which since 2026-08-11 ships the page's products as a JSON island instead of ten
 * rendered edit forms nobody had opened. A row built from one and a row built from the other are
 * the same form, and the only way to keep that true is for one function to answer the question.
 *
 * `rev` is computed HERE rather than in the browser: it is what a save is checked against
 * (`record-rev.ts`), so an AJAX row and a first-paint row deciding it separately is how a stale tab
 * comes to overwrite a newer one.
 */
export interface SellerProductRow extends StoreProduct {
  wishlistCount: number;
  purchasedCount: number;
  categoryPath: string;
  rev: string;
}

export interface SellerProductRowContext {
  /** Keyed by product SLUG — what `getWishlistCountsForStore` returns. */
  wishlistCounts: Record<string, number>;
  /** Keyed by product ID — what `getPurchasedCountsByStoreSlug` returns. */
  purchasedCounts: Record<string, number>;
  /** Keyed by product ID: the full "מעילים / חורף" path, already resolved from the tree. */
  categoryPaths: Map<string, string>;
}

export function toSellerProductRow(p: StoreProduct, ctx: SellerProductRowContext): SellerProductRow {
  return {
    ...p,
    wishlistCount: ctx.wishlistCounts[p.slug] ?? 0,
    purchasedCount: ctx.purchasedCounts[p.id] ?? 0,
    categoryPath: ctx.categoryPaths.get(p.id) ?? '',
    rev: productEditRev(p),
  };
}
