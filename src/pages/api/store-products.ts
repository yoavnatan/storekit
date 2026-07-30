export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlugOrPrevious, isStoreVisible } from '../../lib/stores.js';
import { getVisibleProductsByStoreId, toPublicProduct } from '../../lib/store-products.js';
import { getPurchasedCountsByStoreSlug } from '../../lib/orders.js';
import { filterAndSortProducts, PRODUCTS_PAGE_SIZE } from '../../lib/product-listing.js';
import { getCategoriesByStoreId, resolveCategoryFilterIds } from '../../lib/store-categories.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// "Load more" pagination for the public store page — offset/limit over the same
// filterAndSortProducts() the page's own initial SSR render uses, so results never drift.
export const GET: APIRoute = async ({ url }) => {
  const storeSlug = url.searchParams.get('store') ?? '';
  const store = storeSlug ? getStoreBySlugOrPrevious(storeSlug) : null;
  if (!store || !isStoreVisible(store)) return json({ ok: false, error: 'Store not found.' }, 404);

  const category = url.searchParams.get('category') ?? '';
  const sort = url.searchParams.get('sort') ?? 'default';
  const q = url.searchParams.get('q') ?? '';
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const categoryIds = category ? resolveCategoryFilterIds(getCategoriesByStoreId(store.id), category) : undefined;

  // Blocked individual products (see admin-moderation.ts) never appear in the
  // store's own "load more" pagination either.
  // Same popularity signal the page's SSR render uses, so paged results rank identically.
  const purchasedUnits = getPurchasedCountsByStoreSlug(store.slug);
  // `sale` rides along so a "price: low to high" page orders by what the shopper would pay.
  const filtered = filterAndSortProducts(getVisibleProductsByStoreId(store.id), { categoryIds, sort, q, purchasedUnits, sale: store.sale });
  const products = filtered.slice(offset, offset + PRODUCTS_PAGE_SIZE);

  return json({
    ok: true,
    // Never the raw rows — they carry the seller's private note (see toPublicProduct).
    products: products.map(toPublicProduct),
    hasMore: offset + products.length < filtered.length,
  });
};
