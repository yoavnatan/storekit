import type { StoreProduct } from './store-products.js';
import { isProductInStock } from './variant-combo.js';
import { performanceTier, PERFORMANCE_TIERS, DEFAULT_LABEL_THRESHOLDS } from './product-labels.js';
import { effectivePrice, type StoreSale } from './discounts.js';

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
  // productId → lifetime units SOLD (orders.ts#getPurchasedCountsByStoreSlug — revenue-counting
  // orders only, so payment-pending, failed and cancelled are all excluded). Powers the 'default'
  // ranking's popularity signal; omitted → every product scores as zero-sales.
  // It said "units ordered" until the counter was narrowed to sales that stuck; the wording is
  // load-bearing here because this same map feeds `custom_label_1` in the Merchant/Meta feed, and
  // a reader who believes failed orders are included would draw the wrong conclusion about why a
  // product is ranked where it is.
  purchasedUnits?: Record<string, number>;
  // ms epoch for the "new" recency window; defaults to Date.now(). Pass a fixed value in tests.
  nowMs?: number;
  // The store's running sale, if any — so "price: low to high" sorts by what the shopper
  // would actually PAY, not by the struck-through figure. Omitted = full price everywhere.
  sale?: StoreSale | null;
}

// Strongest tier first → highest rank value. Reuses the ad-label tiers so storefront
// ranking and campaign segmentation agree on what "bestseller"/"popular"/"new" mean.
const TIER_RANK: Record<string, number> = Object.fromEntries(
  PERFORMANCE_TIERS.map((tier, i) => [tier, PERFORMANCE_TIERS.length - i]),
);

/**
 * The 'default' storefront ranking (no explicit sort chosen). Deterministic — no randomness —
 * so SSR, "load more", and re-filters all agree and it stays SEO-safe. Order of precedence:
 *   1. Buyable first — everything in stock ranks above everything sold out (a sold-out
 *      product, even a brand-new one, sinks to the bottom but is still listed, for SEO).
 *   2. Proven demand — platform_bestseller › bestseller › popular › new › standard.
 *   3. Within a tier, more units sold first, then newer first.
 * Net effect: bestsellers/popular lead, a fresh upload gets a real visibility boost (the
 * 'new' tier) without burying proven sellers, and dead/sold-out stock falls to the end.
 */
function rankDefault(products: StoreProduct[], purchasedUnits: Record<string, number>, nowMs: number): StoreProduct[] {
  const t = DEFAULT_LABEL_THRESHOLDS;
  const tierOf = (p: StoreProduct) =>
    TIER_RANK[performanceTier(purchasedUnits[p.id] ?? 0, p.createdAt, t, nowMs)] ?? 0;

  return [...products].sort((a, b) => {
    const aIn = isProductInStock(a.stock, a.variants, a.variantStock);
    const bIn = isProductInStock(b.stock, b.variants, b.variantStock);
    if (aIn !== bIn) return aIn ? -1 : 1;

    const at = tierOf(a), bt = tierOf(b);
    if (at !== bt) return bt - at;

    const au = purchasedUnits[a.id] ?? 0, bu = purchasedUnits[b.id] ?? 0;
    if (au !== bu) return bu - au;

    // Final tiebreak: newer first (deterministic; there is no manual product order).
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
}

// Normalize Hebrew text for search: remove nikud, normalize sofit letters, collapse punctuation.
// Kept byte-for-byte identical to the store page's own client-side copy (used for instant
// re-filtering before a server round-trip resolves) so results never disagree between the two.
// Exported for site-search.ts (platform-wide store+product search) — same word-match rules apply.
export function normalizeHe(str: string): string {
  return str
    .toLowerCase()
    .replace(/[ְ-ׇֽֿׁׂׅׄ]/g, '') // nikud
    .replace(/[ן]/g, 'נ').replace(/[ף]/g, 'פ').replace(/[ך]/g, 'כ')
    .replace(/[ם]/g, 'מ').replace(/[ץ]/g, 'צ')
    .replace(/[׳״’“”]/g, '') // geresh / quotes
    .replace(/[-_.,!?;:()\[\]{}/\\״׳]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function matchesQueryWords(query: string, haystack: string): boolean {
  if (!query) return true;
  const nQuery = normalizeHe(query);
  const nHaystack = normalizeHe(haystack);
  return nQuery.split(' ').every((word) => word && nHaystack.includes(word));
}

function matchesSearch(query: string, name: string, tags: string): boolean {
  return matchesQueryWords(query, `${name} ${tags.replace(/,/g, ' ')}`);
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

  if (sort === 'default') return rankDefault(filtered, query.purchasedUnits ?? {}, query.nowMs ?? Date.now());

  return [...filtered].sort((a, b) => {
    switch (sort) {
      case 'name-asc':   return a.name.localeCompare(b.name);
      case 'name-desc':  return b.name.localeCompare(a.name);
      case 'price-asc':  return effectivePrice(a, query.sale) - effectivePrice(b, query.sale);
      case 'price-desc': return effectivePrice(b, query.sale) - effectivePrice(a, query.sale);
      case 'newest':     return b.createdAt > a.createdAt ? 1 : -1;
      default: return 0;
    }
  });
}
