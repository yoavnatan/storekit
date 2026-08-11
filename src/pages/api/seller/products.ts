export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { ownedStore } from '../../../lib/store-ownership.js';
import { getProductsByStoreId, countStockAlerts } from '../../../lib/store-products.js';
import { LOW_STOCK_THRESHOLD } from '../../../lib/variant-combo.js';
import { getCategoriesByStoreId, categoryPath } from '../../../lib/store-categories.js';
import { getWishlistCountsForStore } from '../../../lib/user-carts.js';
import { getPurchasedCountsByStoreSlug } from '../../../lib/orders.js';
import { filterAndSortSellerProducts, parseSellerProductQuery } from '../../../lib/seller-products-query.js';
import { paginate, parsePage } from '../../../lib/pagination.js';
import { toSellerProductRow } from '../../../lib/seller-product-row.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// AJAX pagination for the seller dashboard's Products tab (mirrors the
// admin dashboard's server-paginated list tabs) — the initial SSR render in
// dashboard.astro uses this exact same query/filter/sort/paginate pipeline
// for page 1, so results never drift between first load and a fetch.
export const GET: APIRoute = async ({ url, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const storeId = url.searchParams.get('storeId') ?? '';
  const store = await ownedStore(sellerId, storeId);
  if (!store) return json({ ok: false, error: 'Not authorized' }, 403);

  const sp = url.searchParams;
  const page = parsePage(sp, 'ppage');
  const pageSize = Math.max(1, Math.min(100, parseInt(sp.get('psize') ?? '20', 10) || 20));
  const query = parseSellerProductQuery(sp);

  const products = (await getProductsByStoreId(store.id)).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const categories = await getCategoriesByStoreId(store.id);
  const categoryPaths = new Map(products.map((p) => [p.id, p.categoryId ? categoryPath(categories, p.categoryId) : '']));
  const wishlistCounts = await getWishlistCountsForStore(store.id);
  const purchasedCounts = await getPurchasedCountsByStoreSlug(store.slug);

  const filtered = filterAndSortSellerProducts(products, categoryPaths, wishlistCounts, purchasedCounts, query);
  const { items, totalPages, total } = paginate(filtered, page, pageSize);

  return json({
    ok: true,
    // One mapper, shared with the dashboard's own first paint (lib/seller-product-row.ts) — both
    // feed the same client-side row builder, so a row from here and a row from there have to be
    // the same object. Its header carries why `rev` is computed server-side.
    items: items.map((p) => toSellerProductRow(p, { wishlistCounts, purchasedCounts, categoryPaths })),
    page,
    totalPages,
    total,
    // Store-wide count (not page-scoped) so the Products-tab stock badge stays
    // accurate after any list re-fetch — add/delete/bulk all flow through here.
    stockAlerts: await countStockAlerts(store.id, LOW_STOCK_THRESHOLD),
  });
};
