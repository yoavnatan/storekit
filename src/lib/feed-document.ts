/**
 * The platform-wide product feed, produced a piece at a time.
 *
 * **Same document as before, assembled differently.** `/api/feed/products.xml` used to run this
 * whole walk inside the request and hand back one string; it is now run by a job and written to
 * storage (`artifacts.ts`, migration 0022), and the route serves what is there. Everything that
 * decides WHAT is in the feed is unchanged and still lives where it did — `getIndexableStores`
 * (visible, non-demo), `buildFeedItems` (per-product attributes, variant rows, the advertisability
 * rule), `adLandingUrl` (always the platform domain). The only thing that moved is when.
 *
 * **Why a generator and not a function returning the document.** Two reasons, and the second is the
 * one that is easy to miss. Memory: nothing here ever holds more than one batch of stores, so the
 * ceiling is a batch rather than the catalogue. And the event loop: this build runs in the same
 * process that serves shoppers, so what matters is not only how long it takes but whether it lets
 * anything else through while it does. Yielding per item means the writer's `await` on its next
 * insert lands every ~256KB, and every one of those hands the loop back. A version that built the
 * string and yielded it once would be just as memory-hungry and just as blocking as what it
 * replaced.
 *
 * **The store LIST is still read whole**, and that is deliberate: it is one row per store with no
 * catalogue attached, and the visibility rules it applies (`isStoreDiscoverable`, `isDemoStore`)
 * are JS predicates over the lifecycle table on purpose — pushing them into SQL to add a `LIMIT`
 * would be the second reading of those rules that `tests/store-lifecycle-guard.test.ts` exists to
 * refuse. Stores are counted in thousands; products are what is counted in hundreds of thousands,
 * and products are what is batched.
 */
import { getIndexableStores, type Store } from './stores.js';
import { getVisibleProductsByStoreIds, type StoreProduct } from './store-products.js';
import { getCategoriesByStoreIds, categoryPath, type StoreCategory } from './store-categories.js';
import { getPurchasedCountsByStoreSlugs } from './orders.js';
import { store as platform } from '../config/store.config.js';
import {
  buildFeedItems,
  feedItemXml,
  feedXmlHeader,
  FEED_XML_FOOTER,
  type FeedChannelMeta,
  type FeedItem,
} from './product-feed.js';
import { stripTrailingSlashes } from './url-base.js';
import { adLandingUrl } from './custom-domain.js';
import { batches, STORE_BATCH, type CatalogBuildStats } from './catalog-build.js';

/** The channel frame. A function and not a constant because `platform.url` is the one value that
 *  changes on the go-live domain switch, and nothing here may cache it across that. */
export function feedChannelMeta(): FeedChannelMeta {
  const baseUrl = stripTrailingSlashes(platform.url);
  return {
    title: `${platform.name} — Product feed`,
    link: baseUrl,
    description: `Product catalog feed for ${platform.name} (Google Merchant Center / Meta Catalog).`,
    currency: platform.business.currency,
  };
}

/**
 * Every feed row one store contributes, in order.
 *
 * Exported because it is the WHOLE per-store policy of this document, and the generator below is
 * only the order and the separators. `tests/catalog-artifacts.test.ts` composes the expected feed
 * from this function, so the test can prove the streamed document is byte-identical to a single-shot
 * one without holding a second copy of what a row contains — a second copy is what would silently
 * stop asserting anything the day this changed.
 */
export function storeFeedItems(
  store: Store,
  products: readonly StoreProduct[],
  categories: StoreCategory[],
  purchased: Record<string, number>,
  baseUrl: string,
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const product of products) {
    const cPath = product.categoryId ? categoryPath(categories, product.categoryId) : undefined;
    items.push(...buildFeedItems(product, {
      storeName: store.name,
      // Always the PLATFORM domain — the only domain this Merchant Center / Business account can
      // claim — and marked so the store's custom-domain 301 stands aside for it. The page serves
      // that exact URL and declares it canonical, so the feed link, the redirect and the canonical
      // finally say one thing (custom-domain.ts#AD_LANDING_PARAM).
      productLink: (slug) => adLandingUrl(store, slug),
      baseUrl,
      categoryPath: cPath,
      purchasedUnits: purchased[product.id],
      storeTags: store.categories,
      sale: store.sale,
    }));
  }
  return items;
}

/** The feed document, in order. `stats.stores` counts every indexable store walked (some carry no
 *  advertisable product), `stats.items` the `<item>` rows written. Concatenating every chunk gives
 *  exactly what `toMerchantXml` would have returned for the same items — the property
 *  `tests/catalog-artifacts.test.ts` asserts. */
export async function* feedDocumentChunks(stats: CatalogBuildStats): AsyncGenerator<string> {
  const meta = feedChannelMeta();
  yield feedXmlHeader(meta);

  const stores = await getIndexableStores();
  stats.stores = stores.length;
  let first = true;

  for (const batch of batches(stores, STORE_BATCH)) {
    const storeIds = batch.map((s) => s.id);
    // Independent reads, so one round trip rather than three (AI_INSTRUCTIONS → Scalability).
    const [categoriesByStore, productsByStore, purchasedByStore] = await Promise.all([
      getCategoriesByStoreIds(storeIds),
      getVisibleProductsByStoreIds(storeIds),
      getPurchasedCountsByStoreSlugs(batch.map((s) => s.slug)),
    ]);

    for (const store of batch) {
      const items = storeFeedItems(
        store,
        productsByStore.get(store.id) ?? [],
        categoriesByStore.get(store.id) ?? [],
        purchasedByStore.get(store.slug) ?? {},
        meta.link,
      );
      for (const item of items) {
        // The newline BEFORE every item but the first is what `items.join('\n')` used to do.
        yield `${first ? '' : '\n'}${feedItemXml(item, meta.currency)}`;
        first = false;
        stats.items++;
      }
    }
  }

  yield FEED_XML_FOOTER;
}
