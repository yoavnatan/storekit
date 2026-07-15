import type { StoreProduct } from './store-products.js';
import { matchesQueryWords } from './product-listing.js';
import { decodeList } from './admin-nav.js';

// Server-side counterpart of the seller dashboard's Products tab toolbar
// (src/scripts/dashboard/products.ts) — pagination means the toolbar can no
// longer just show/hide DOM rows already on the page, so search+sort+filter
// have to run here over the full product list before slicing to a page, the
// same way admin-orders-filter.ts already does for the admin Orders tab.
export type SellerProductSortCol = 'createdAt' | 'name' | 'price' | 'stock' | 'wishlist' | 'category' | 'purchased';
export type SellerProductSortDir = 'asc' | 'desc';

export interface SellerProductQuery {
  q: string;
  sortCol: SellerProductSortCol;
  sortDir: SellerProductSortDir;
  // Category *display paths* (e.g. "ביגוד › חולצות"), not ids — the
  // toolbar's own filter-value checkboxes are keyed by path (same values a
  // product row's data-category carries), so matching on path here avoids a
  // separate id round-trip. Multiple = OR, same as the toolbar's checkboxes.
  categoryPaths: string[];
}

const VALID_SORT_COLS = new Set<string>(['createdAt', 'name', 'price', 'stock', 'wishlist', 'category', 'purchased']);

// col/dir validated independently (not as a fixed combo whitelist) — the
// toolbar's own header buttons toggle either direction on every sortable
// column (see headerSortClick in products.ts), so a combo whitelist would
// silently fall back to the default on, say, a second click of "wishlist".
export function parseSellerProductQuery(sp: URLSearchParams): SellerProductQuery {
  const [rawCol, rawDir] = (sp.get('psort') ?? 'createdAt:desc').split(':');
  const sortCol = (VALID_SORT_COLS.has(rawCol ?? '') ? rawCol : 'createdAt') as SellerProductSortCol;
  const sortDir: SellerProductSortDir = rawDir === 'asc' ? 'asc' : 'desc';
  return {
    q: (sp.get('pq') ?? '').trim(),
    sortCol,
    sortDir,
    categoryPaths: decodeList(sp.get('pcat') ?? ''), // paths may contain commas (nested category names)
  };
}

export function filterAndSortSellerProducts(
  products: StoreProduct[],
  categoryPaths: Map<string, string>,
  wishlistCounts: Record<string, number>,
  purchasedCounts: Record<string, number>,
  query: SellerProductQuery,
): StoreProduct[] {
  const catSet = query.categoryPaths.length ? new Set(query.categoryPaths) : null;
  const filtered = products.filter((p) => {
    if (catSet && !catSet.has(categoryPaths.get(p.id) ?? '')) return false;
    return matchesQueryWords(query.q, `${p.name} ${p.sku ?? ''} ${categoryPaths.get(p.id) ?? ''}`);
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    let cmp: number;
    switch (query.sortCol) {
      case 'name':      cmp = a.name.localeCompare(b.name, 'he'); break;
      case 'price':     cmp = a.price - b.price; break;
      case 'stock':     cmp = a.stock - b.stock; break;
      case 'wishlist':  cmp = (wishlistCounts[a.slug] ?? 0) - (wishlistCounts[b.slug] ?? 0); break;
      case 'purchased': cmp = (purchasedCounts[a.id] ?? 0) - (purchasedCounts[b.id] ?? 0); break;
      case 'category':  cmp = (categoryPaths.get(a.id) ?? '').localeCompare(categoryPaths.get(b.id) ?? '', 'he'); break;
      default:          cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }
    return cmp * dir;
  });
}
