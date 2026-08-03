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
  const store = storeSlug ? await getStoreBySlugOrPrevious(storeSlug) : null;
  if (!store || !isStoreVisible(store)) return json({ ok: false, error: 'Store not found.' }, 404);

  const category = url.searchParams.get('category') ?? '';
  const sort = url.searchParams.get('sort') ?? 'default';
  const q = url.searchParams.get('q') ?? '';
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);

  // **Three independent reads, issued together — this is the shopper-facing latency (2026-08-03).**
  // Every category chip click on a store page lands here, and the three reads below depend only on
  // `store`, not on each other. Awaited one after another they were three separate round trips to
  // the database, in series, on the click path: measured against Neon from a laptop, the endpoint
  // spent 266ms purely waiting, and 134ms of that was queue rather than work. It was invisible while
  // this data came from local JSON files — a file read has no round trip to serialise, so the
  // sequential shape cost nothing and read perfectly naturally. The DB migration is what turned the
  // same lines into four network hops, which is why the grid now sits dimmed long enough to notice.
  //
  // The pool is what makes this real: `Promise.all` over a pooled connection set genuinely overlaps
  // them (a single client would serialise and this would buy nothing). Blocked individual products
  // are excluded by the query itself, and `purchasedUnits` is the same popularity signal the page's
  // own SSR render uses, so a paged result ranks identically to the first page.
  const [categories, purchasedUnits, visibleProducts] = await Promise.all([
    category ? getCategoriesByStoreId(store.id) : Promise.resolve([]),
    getPurchasedCountsByStoreSlug(store.slug),
    getVisibleProductsByStoreId(store.id),
  ]);
  const categoryIds = category ? resolveCategoryFilterIds(categories, category) : undefined;

  // `sale` rides along so a "price: low to high" page orders by what the shopper would pay.
  const filtered = filterAndSortProducts(visibleProducts, { categoryIds, sort, q, purchasedUnits, sale: store.sale });
  const products = filtered.slice(offset, offset + PRODUCTS_PAGE_SIZE);

  return json({
    ok: true,
    // Never the raw rows — they carry the seller's private note (see toPublicProduct).
    products: products.map(toPublicProduct),
    hasMore: offset + products.length < filtered.length,
  });
};
