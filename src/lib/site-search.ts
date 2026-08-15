import { getShopperStores } from './stores.js';
import { isDemoStore } from './demo-stores.js';
import { isStoreReady } from './store-readiness.js';
import { getProductCountsByStore, searchVisibleProducts } from './store-products.js';
import { matchesQueryWords } from './product-listing.js';
import { cdnSrc } from '../config/store.config.js';
import { resolvePrice } from './discounts.js';

export interface StoreSearchHit {
  name: string;
  slug: string;
  tagline: string;
  /** Store logo (cdnSrc-transformed) — '' when the seller hasn't set one, so the
   *  UI falls back to an initial avatar rather than a generic icon. */
  image: string;
}

export interface ProductSearchHit {
  name: string;
  slug: string;
  /** The price the shopper would actually pay — resolved against the product's store sale
   *  (discounts.ts), so a search result can't quote a price checkout won't honour. */
  price: number;
  /** Pre-discount price, present only when this hit is discounted. */
  basePrice?: number;
  percentOff?: number;
  image: string;
  storeSlug: string;
  storeName: string;
  /** The hit belongs to a showcase store (`demo-stores.ts`). Search lists those while the mall is
   *  thin (see the comment on the store query below), so the result card has to carry the same
   *  per-product disclosure the store's own grid does — this is where a shopper meets a demo
   *  product without ever passing the store page. Present only when true, like `basePrice`. */
  demo?: boolean;
}

const DEFAULT_STORE_LIMIT = 6;
const DEFAULT_PRODUCT_LIMIT = 8;
const DEFAULT_IMAGE_WIDTH = 112;

/**
 * How much of a search box this endpoint will read.
 *
 * `/api/search` is UNAUTHENTICATED and a query string carries ~16KB, so the length of the term is
 * request-controlled on a single-threaded SSR server. It always was — the JS matcher walked the
 * whole catalogue with it — and it matters more now that the term becomes a `LIKE` pattern probed
 * against a trigram index. Same cap and the same reasoning as the money journal's own search
 * (`admin-moneylog-filter.ts#MAX_SEARCH_LENGTH`); no real search is longer, so it costs nothing.
 */
const MAX_QUERY_LENGTH = 200;

export interface SiteSearchOptions {
  /** Caller-tuned caps — the header dropdown wants a short preview (defaults), the
   * dedicated /search results page wants a real page's worth. */
  storeLimit?: number;
  productLimit?: number;
  /** cdnSrc width for product thumbnails — the dropdown's tiny row vs. a real grid card. */
  imageWidth?: number;
}

// Platform-wide search for the header search bar: matches stores by name/tagline/
// description and products by name/tags/variant values, each product hit carries its store's
// name+slug so a product result can show "which store it's in" next to it. Powers
// both the header dropdown preview (small caps) and the dedicated /search results
// page (larger caps) — same matching logic, just different limits/image size.
//
// **The product half is a query, not a scan (§3, 2026-08-03.)** This used to call
// `getAllProducts()` and filter in Node — the whole catalogue into memory on every keystroke of
// the header search box, to keep eight rows. It is now one indexed `LIKE` per query word against
// `store_products.search_text` (store-products.ts#searchVisibleProducts), which carries the same
// Hebrew normalisation `matchesQueryWords` applies here to the STORE half.
//
// The store half stays in memory deliberately: it matches name+tagline+description over the
// shopper roster, which the caller already holds and which is bounded by how many stores exist,
// not by how much they sell.
export async function searchSite(rawQuery: string, options: SiteSearchOptions = {}): Promise<{ stores: StoreSearchHit[]; products: ProductSearchHit[] }> {
  const q = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  if (!q) return { stores: [], products: [] };

  const storeLimit = options.storeLimit ?? DEFAULT_STORE_LIMIT;
  const productLimit = options.productLimit ?? DEFAULT_PRODUCT_LIMIT;
  const imageWidth = options.imageWidth ?? DEFAULT_IMAGE_WIDTH;

  // Admin-blocked stores/products (see admin-moderation.ts) never surface in
  // search — same reasoning as the homepage/directory feeds. Showcase stores are
  // included only while the mall is thin (lib/demo-stores.ts): search is a
  // shopper-discovery surface, so it follows the same rule the homepage does.
  const stores = await getShopperStores();
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const storeIds = stores.map((s) => s.id);

  // Two independent narrowings, so they go together: the readiness counts for the store half and
  // the matching products for the product half.
  const [counts, products] = await Promise.all([
    getProductCountsByStore(storeIds),
    searchVisibleProducts(q, storeIds, productLimit),
  ]);

  // Store hits are also gated on readiness (lib/store-readiness.ts): a store with nothing to buy
  // is a dead end, and a search result is a promise that the link goes somewhere. Filtered BEFORE
  // the limit slice so an unready store can't consume one of the few store slots.
  const matchedStores: StoreSearchHit[] = stores
    .filter((s) => isStoreReady({ visibleProductCount: counts.get(s.id)?.visible ?? 0 }))
    .filter((s) => matchesQueryWords(q, `${s.name} ${s.tagline} ${s.description}`))
    .slice(0, storeLimit)
    .map((s) => ({
      name: s.name,
      slug: s.slug,
      tagline: s.tagline,
      image: s.profileImage ? cdnSrc(s.profileImage, imageWidth) : '',
    }));

  const matchedProducts: ProductSearchHit[] = [];
  for (const p of products) {
    const store = storeById.get(p.storeId);
    if (!store) continue;
    const pv = resolvePrice(p, store.sale);
    matchedProducts.push({
      name: p.name,
      slug: p.slug,
      price: pv.price,
      ...(pv.isDiscounted ? { basePrice: pv.basePrice, percentOff: pv.percentOff } : {}),
      image: p.images?.[0] ? cdnSrc(p.images[0], imageWidth) : '',
      storeSlug: store.slug,
      storeName: store.name,
      ...(isDemoStore(store) ? { demo: true } : {}),
    });
  }

  return { stores: matchedStores, products: matchedProducts };
}
