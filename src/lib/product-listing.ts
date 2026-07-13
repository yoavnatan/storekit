import type { StoreProduct } from './store-products.js';

export type ProductSort = 'default' | 'name-asc' | 'name-desc' | 'price-asc' | 'price-desc' | 'newest';

/** Shared by the store page's initial SSR render and /api/store-products so "load more" pages match exactly. */
export const PRODUCTS_PAGE_SIZE = 24;

export interface ProductListingQuery {
  // The selected category's own id plus every descendant id — resolved by the
  // caller via store-categories.ts#getDescendantIds() — so picking "ביגוד" also
  // matches products filed under "גברים" or "חולצות" beneath it. Undefined/empty = no filter.
  categoryIds?: string[];
  sort?: string;
  q?: string;
}

// Normalize Hebrew text for search: remove nikud, normalize sofit letters, collapse punctuation.
// Kept byte-for-byte identical to the store page's own client-side copy (used for instant
// re-filtering before a server round-trip resolves) so results never disagree between the two.
function normalizeHe(str: string): string {
  return str
    .toLowerCase()
    .replace(/[ְ-ׇֽֿׁׂׅׄ]/g, '') // nikud
    .replace(/[ן]/g, 'נ').replace(/[ף]/g, 'פ').replace(/[ך]/g, 'כ')
    .replace(/[ם]/g, 'מ').replace(/[ץ]/g, 'צ')
    .replace(/[׳״’“”]/g, '') // geresh / quotes
    .replace(/[-_.,!?;:()\[\]{}/\\״׳]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function matchesSearch(query: string, name: string, tags: string): boolean {
  if (!query) return true;
  const nQuery = normalizeHe(query);
  const nCombined = normalizeHe(name) + ' ' + normalizeHe(tags.replace(/,/g, ' '));
  return nQuery.split(' ').every((word) => word && nCombined.includes(word));
}

/** Single source of truth for category+search+sort — used server-side by both the store page's initial render and the load-more API, so behavior never drifts between the two. */
export function filterAndSortProducts(products: StoreProduct[], query: ProductListingQuery): StoreProduct[] {
  const categoryIds = query.categoryIds?.length ? new Set(query.categoryIds) : null;
  const q = query.q?.trim() ?? '';
  const sort = (query.sort?.trim() || 'default') as ProductSort;

  const filtered = products.filter((p) => {
    const matchesCategory = !categoryIds || (!!p.categoryId && categoryIds.has(p.categoryId));
    return matchesCategory && matchesSearch(q, p.name, p.tags?.join(',') ?? '');
  });

  if (sort === 'default') return filtered;

  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'name-asc':   return a.name.localeCompare(b.name);
      case 'name-desc':  return b.name.localeCompare(a.name);
      case 'price-asc':  return a.price - b.price;
      case 'price-desc': return b.price - a.price;
      case 'newest':     return b.createdAt > a.createdAt ? 1 : -1;
      default: return 0;
    }
  });
}
