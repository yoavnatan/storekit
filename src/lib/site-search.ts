import { getVisibleStores } from './stores.js';
import { readProducts, isProductVisible } from './store-products.js';
import { matchesQueryWords } from './product-listing.js';
import { cdnSrc } from '../config/store.config.js';

export interface StoreSearchHit {
  name: string;
  slug: string;
  tagline: string;
}

export interface ProductSearchHit {
  name: string;
  slug: string;
  price: number;
  image: string;
  storeSlug: string;
  storeName: string;
}

const DEFAULT_STORE_LIMIT = 6;
const DEFAULT_PRODUCT_LIMIT = 8;
const DEFAULT_IMAGE_WIDTH = 112;

export interface SiteSearchOptions {
  /** Caller-tuned caps — the header dropdown wants a short preview (defaults), the
   * dedicated /search results page wants a real page's worth. */
  storeLimit?: number;
  productLimit?: number;
  /** cdnSrc width for product thumbnails — the dropdown's tiny row vs. a real grid card. */
  imageWidth?: number;
}

// Platform-wide search for the header search bar: matches stores by name/tagline/
// description and products by name/tags, each product hit carries its store's
// name+slug so a product result can show "which store it's in" next to it. Powers
// both the header dropdown preview (small caps) and the dedicated /search results
// page (larger caps) — same matching logic, just different limits/image size.
// Scans every product on every request (same JSON-file-era tradeoff already accepted
// for sellerHasAnyAlert — see AI_INSTRUCTIONS.md → Hard rules → Scalability; becomes an
// indexed/full-text query once this is a real DB, no shape change needed here).
export function searchSite(rawQuery: string, options: SiteSearchOptions = {}): { stores: StoreSearchHit[]; products: ProductSearchHit[] } {
  const q = rawQuery.trim();
  if (!q) return { stores: [], products: [] };

  const storeLimit = options.storeLimit ?? DEFAULT_STORE_LIMIT;
  const productLimit = options.productLimit ?? DEFAULT_PRODUCT_LIMIT;
  const imageWidth = options.imageWidth ?? DEFAULT_IMAGE_WIDTH;

  // Admin-blocked stores/products (see admin-moderation.ts) never surface in
  // search — same reasoning as the homepage/directory feeds.
  const stores = getVisibleStores();
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const matchedStores: StoreSearchHit[] = stores
    .filter((s) => matchesQueryWords(q, `${s.name} ${s.tagline} ${s.description}`))
    .slice(0, storeLimit)
    .map((s) => ({ name: s.name, slug: s.slug, tagline: s.tagline }));

  const matchedProducts: ProductSearchHit[] = [];
  for (const p of readProducts()) {
    if (matchedProducts.length >= productLimit) break;
    if (!isProductVisible(p)) continue;
    if (!matchesQueryWords(q, `${p.name} ${(p.tags ?? []).join(' ')}`)) continue;
    const store = storeById.get(p.storeId);
    if (!store) continue;
    matchedProducts.push({
      name: p.name,
      slug: p.slug,
      price: p.price,
      image: p.images?.[0] ? cdnSrc(p.images[0], imageWidth) : '',
      storeSlug: store.slug,
      storeName: store.name,
    });
  }

  return { stores: matchedStores, products: matchedProducts };
}
