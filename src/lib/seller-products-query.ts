import type { StoreProduct } from './store-products.js';
import { matchesQueryWords } from './product-listing.js';
import { decodeList } from './admin-nav.js';
import { LOW_STOCK_THRESHOLD } from './store-products.js';

// Server-side counterpart of the seller dashboard's Products tab toolbar
// (src/scripts/dashboard/products.ts) — pagination means the toolbar can no
// longer just show/hide DOM rows already on the page, so search+sort+filter
// have to run here over the full product list before slicing to a page, the
// same way admin-orders-filter.ts already does for the admin Orders tab.
export type SellerProductSortCol = 'createdAt' | 'name' | 'price' | 'stock' | 'wishlist' | 'category' | 'purchased';
export type SellerProductSortDir = 'asc' | 'desc';

// Stock-status buckets (CURRENT_TASK.md item 3) — lets a seller isolate just the
// problem inventory. Thresholds mirror LOW_STOCK_THRESHOLD, the same rule the
// products-tab stock-alert badge counts on.
export type StockStatus = 'out' | 'low' | 'ok';
const VALID_STOCK_STATUSES = new Set<string>(['out', 'low', 'ok']);
export function stockBucket(stock: number): StockStatus {
  return stock <= 0 ? 'out' : stock <= LOW_STOCK_THRESHOLD ? 'low' : 'ok';
}

export interface SellerProductQuery {
  q: string;
  sortCol: SellerProductSortCol;
  sortDir: SellerProductSortDir;
  // Category *display paths* (e.g. "ביגוד › חולצות"), not ids — the
  // toolbar's own filter-value checkboxes are keyed by path (same values a
  // product row's data-category carries), so matching on path here avoids a
  // separate id round-trip. Multiple = OR, same as the toolbar's checkboxes.
  categoryPaths: string[];
  // Selected stock buckets (out/low/ok). Empty = no stock restriction; multiple
  // = OR (same semantics as the category filter).
  stockStatuses: StockStatus[];
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
    stockStatuses: (sp.get('pstock') ?? '').split(',').map((s) => s.trim()).filter((s): s is StockStatus => VALID_STOCK_STATUSES.has(s)),
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
  const stockSet = query.stockStatuses.length ? new Set<string>(query.stockStatuses) : null;
  const filtered = products.filter((p) => {
    if (catSet && !catSet.has(categoryPaths.get(p.id) ?? '')) return false;
    if (stockSet && !stockSet.has(stockBucket(p.stock))) return false;
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
