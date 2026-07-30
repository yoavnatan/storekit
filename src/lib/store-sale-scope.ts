/** Flattens a store sale's category scope: the seller picks one or more categories, and the sale
 *  covers each of them plus everything beneath it (same rule the storefront's category filter
 *  uses). Two lists come out of that and they are NOT the same thing — `pickedCategoryIds` is
 *  what a human chose and what the banner names, `categoryIds` is that expanded downward and is
 *  what a price is matched against.
 *
 *  The flattened list is STORED on the sale rather than recomputed per read, because
 *  `discounts.ts#resolvePrice` runs in the browser too (the store grid's "load more" resolves
 *  its own prices) where the category tree isn't available. The cost of storing it is that the
 *  list goes stale when the tree changes — so every category mutation re-runs this, which is
 *  why it lives in its own module rather than inside the save-sale handler.
 */

import { categoryPath, getCategoriesByStoreId, getCategoryById, resolveCategoryFilterIds, type StoreCategory } from './store-categories.js';
import { getStoreById, updateStore } from './stores.js';
import { getProductsByStoreId } from './store-products.js';
import { formatScopeNames } from './sale-scope-label.js';
import type { SaleScopeInput } from './discount-input.js';
import { salePickedCategoryIds, type StoreSale } from './discounts.js';

export type SaleScope = SaleScopeInput;

/** Keeps only ids that are really this store's products — a hand-crafted POST can otherwise
 *  name another seller's product and pull it into this store's sale. Order + duplicates are
 *  normalized away so the stored list is stable across saves. */
export function resolveSaleProductScope(storeId: string, ids: string[]): SaleScope | undefined {
  const wanted = new Set(ids.map((id) => id.trim()).filter(Boolean));
  if (!wanted.size) return undefined;
  const owned = getProductsByStoreId(storeId).filter((p) => wanted.has(p.id)).map((p) => p.id);
  return owned.length ? { productIds: owned } : undefined;
}

/** How many categories one sale may name. A scope that reaches most of the tree is a store-wide
 *  sale wearing a costume — and the banner can only name a couple before it stops informing
 *  anyone. Enforced here rather than in the UI so a hand-built POST can't exceed it either. */
export const MAX_SALE_CATEGORIES = 8;

/** `undefined` for "whole store" — no valid pick left after validation. Each id must be this
 *  store's own (never trust a client-sent id: a scope pointing at another seller's category
 *  would silently discount nothing here and leak that the id exists), and the flattened result
 *  is the UNION of every pick plus everything beneath it. Duplicates — which a seller creates
 *  simply by picking a parent and one of its children — collapse, so the stored list is stable
 *  and `saleCoversProduct` stays a plain membership test. */
export function resolveSaleScope(storeId: string, categoryIds: string[]): SaleScope | undefined {
  const tree = getCategoriesByStoreId(storeId);
  const picked: string[] = [];
  const flattened = new Set<string>();

  for (const raw of categoryIds) {
    const id = raw.trim();
    if (!id || picked.includes(id)) continue;
    const category = getCategoryById(id);
    if (!category || category.storeId !== storeId) continue;
    picked.push(id);
    for (const descendant of resolveCategoryFilterIds(tree, id)) flattened.add(descendant);
    if (picked.length >= MAX_SALE_CATEGORIES) break;
  }

  if (!picked.length || !flattened.size) return undefined;
  // `categoryId` stays the first pick — see StoreSale.categoryId for why it is still written.
  return { categoryId: picked[0], pickedCategoryIds: picked, categoryIds: [...flattened] };
}

/** Re-flatten a store's saved sale after its category tree changed. A no-op for a store with no
 *  sale or an unscoped one. Deleting ONE of several picked categories just narrows the sale to
 *  the ones that survive — only losing them all switches the sale off, rather than silently
 *  widening it to the whole store, since "30% on coats" with the coats category gone is a
 *  promise nobody can read. */
export function refreshStoreSaleScope(storeId: string): void {
  const store = getStoreById(storeId);
  const sale = store?.sale;
  const picks = salePickedCategoryIds(sale);
  if (!store || !sale || !picks.length) return;

  const scope = resolveSaleScope(storeId, picks);
  if (scope?.categoryIds?.length) {
    if (sameIds(scope.categoryIds, sale.categoryIds ?? []) && sameIds(scope.pickedCategoryIds ?? [], picks)) return;
    updateStore(storeId, { sale: { ...sale, categoryId: scope.categoryId, pickedCategoryIds: scope.pickedCategoryIds, categoryIds: scope.categoryIds } });
    return;
  }

  const next: StoreSale = { ...sale, active: false };
  delete next.categoryId;
  delete next.pickedCategoryIds;
  delete next.categoryIds;
  updateStore(storeId, { sale: next });
}

/** The banner's scope line for a category-scoped sale: the seller's own picks, named. One pick
 *  keeps its full path (it disambiguates two same-named categories under different parents);
 *  several are named plainly, because a line of stacked paths reads as noise. Returns '' for a
 *  sale that isn't category-scoped — the caller has its own wording for those. */
export function saleScopeCategoryLabel(
  categories: StoreCategory[],
  sale: StoreSale | undefined,
  andMore: string,
): string {
  const picks = salePickedCategoryIds(sale);
  if (!picks.length) return '';
  const names = picks.length === 1
    ? [categoryPath(categories, picks[0]!)]
    : picks.map((id) => categories.find((c) => c.id === id)?.name ?? '');
  return formatScopeNames(names, andMore);
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
