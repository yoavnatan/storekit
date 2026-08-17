import { getIndexableStores } from './stores.js';
import { getVisibleProductsByStoreIds } from './store-products.js';
import { getReviewsForProductIds } from './product-reviews.js';
import { feedBrand, feedMpn } from './product-feed.js';
import { store as platform } from '../config/store.config.js';
import { adLandingUrl } from './custom-domain.js';
import { stripTrailingSlashes } from './url-base.js';
import { batches, STORE_BATCH, type CatalogBuildStats } from './catalog-build.js';
import {
  REVIEW_FEED_XML_HEADER,
  REVIEW_FEED_XML_FOOTER,
  reviewFeedPublisherXml,
  reviewEntryXml,
} from './review-feed.js';
import { REVIEWS_SECTION_ANCHOR } from './reviews-anchor.js';

/**
 * The platform-wide product REVIEWS feed, produced a piece at a time.
 *
 * Deliberately the same shape as `feed-document.ts` next door, down to the batching and the
 * generator, for the reason that file's header gives: the build runs in the process that serves
 * shoppers, so it must never hold the whole document and must hand the event loop back on a
 * rhythm. This one is far smaller than the product feed — reviews are counted in thousands where
 * products are counted in hundreds of thousands — but "smaller today" is not a shape to build on.
 *
 * **Who is in it is decided by the SAME two functions as the product feed** — `getIndexableStores`
 * (live, non-demo) and `getVisibleProductsByStoreIds` — and by nothing written here. A demo store's
 * fabricated reviews reaching Merchant Center would be a policy violation against the one account
 * every seller shares, and a review whose landing page 404s is the misrepresentation class that
 * suspends it; both are already handled correctly by those two, and a second spelling of either
 * rule is what `tests/store-lifecycle-guard.test.ts` exists to refuse.
 *
 * **A rating-only review is skipped**, and that is the one place this feed is narrower than the
 * product page. Google's schema requires `<content>`, so a review with stars and no words has
 * nothing to submit — it still counts on the page and in the product's average, it simply is not a
 * feed row. `stats.items` therefore counts feed ROWS, not reviews, and the two differ on purpose.
 */
export async function* reviewFeedChunks(stats: CatalogBuildStats): AsyncGenerator<string> {
  const baseUrl = stripTrailingSlashes(platform.url);
  yield REVIEW_FEED_XML_HEADER;
  yield reviewFeedPublisherXml({
    name: platform.name,
    favicon: new URL('/favicon.ico', `${baseUrl}/`).href,
  });

  const stores = await getIndexableStores();
  stats.stores = stores.length;

  for (const batch of batches(stores, STORE_BATCH)) {
    const productsByStore = await getVisibleProductsByStoreIds(batch.map((s) => s.id));
    // Only products that actually carry a review are asked about — the cached count on the product
    // row answers that without touching `product_reviews` at all, so a catalogue of a hundred
    // thousand unreviewed products costs nothing here.
    const rated = batch.flatMap((store) =>
      (productsByStore.get(store.id) ?? [])
        .filter((p) => (p.reviewCount ?? 0) > 0)
        .map((product) => ({ store, product })),
    );
    if (!rated.length) continue;

    const reviewsByProduct = await getReviewsForProductIds(rated.map((r) => r.product.id));

    for (const { store, product } of rated) {
      // Always the PLATFORM domain, and the same URL the product feed publishes as `link` — a
      // review pointing at a different address than the item it reviews is a review Google cannot
      // join to it. `adLandingUrl` is also the one URL guaranteed not to 301 off to a seller's
      // custom domain (custom-domain.ts#AD_LANDING_PARAM).
      const productUrl = adLandingUrl(store, product.slug);
      for (const review of reviewsByProduct.get(product.id) ?? []) {
        if (!review.body.trim()) continue;
        yield reviewEntryXml({
          reviewId: review.id,
          reviewerName: review.reviewerName,
          timestamp: review.createdAt,
          content: review.body,
          rating: review.rating,
          reviewUrl: `${productUrl}#${REVIEWS_SECTION_ANCHOR}`,
          productName: product.name,
          productUrl,
          brand: feedBrand(product, store.name),
          ...(feedMpn(product) ? { mpn: feedMpn(product)! } : {}),
        });
        stats.items++;
      }
    }
  }

  yield REVIEW_FEED_XML_FOOTER;
}
