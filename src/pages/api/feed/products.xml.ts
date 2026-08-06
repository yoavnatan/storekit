export const prerender = false;
import type { APIContext } from 'astro';
import { getIndexableStores } from '../../../lib/stores.js';
import { getVisibleProductsByStoreIds } from '../../../lib/store-products.js';
import { getCategoriesByStoreIds, categoryPath } from '../../../lib/store-categories.js';
import { getPurchasedCountsByStoreSlugs } from '../../../lib/orders.js';
import { store as platform } from '../../../config/store.config.js';
import { buildFeedItems, toMerchantXml, type FeedItem } from '../../../lib/product-feed.js';
import { stripTrailingSlashes } from '../../../lib/url-base.js';
import { adLandingUrl } from '../../../lib/custom-domain.js';
import { singleFlight } from '../../../lib/single-flight.js';

// Platform-wide product feed (CURRENT_TASK.md item 14) — the single bulk export
// Google Merchant Center / Meta Catalog fetch on a schedule to power the
// baseline (and boost) catalog campaigns. Each product is emitted with its own
// derived attributes (gender/age_group/brand/condition/custom_labels — see
// product-feed.ts), so per-product audience targeting is REAL at the data level
// the moment this URL is connected in Merchant Center; no seller opt-in, no
// per-product manual setup. This is the last piece before real-account wiring
// (API keys / GTM / Pixel — items 15-16); until then it's a valid, fetchable
// feed that just isn't pointed at a live account yet.
//
// Only visible (non-blocked, non-demo) stores/products are exported — a blocked
// listing must never keep running in the shared platform's ads, and the
// platform's own showcase stores (lib/demo-stores.ts) are fabricated catalog:
// submitting those to Merchant Center is a policy violation against the whole
// account, not just an aesthetic problem. Unauthenticated on
// purpose: a data feed is a public URL the platforms pull, and it exposes only
// already-public catalog data.
//
// Scale note (JSON-file era): this rebuilds the whole feed per request. Fine at
// current volume + the 1h cache below; at DB-migration time this becomes a
// cached/generated artifact (cron-refreshed or a materialized query), same
// output shape.
//
// **Concurrent pulls share one build (`lib/single-flight.ts`), and that is a graceful-degradation
// measure, not an optimisation.** This route is public, takes no token, and assembles the whole
// platform catalogue into one string — the note above measured 45 stores at 6.1 seconds. Node runs
// one event loop, so that build blocks every other request in the process, a shopper at checkout
// included. Google retries a slow feed, Meta pulls on its own schedule, and anyone at all can hold
// `curl` down: without the guard each of those starts its own full-catalogue build, and the feed —
// a service no buyer has ever heard of — becomes the reason the store is unreachable. With it, N
// simultaneous pulls cost one build. Sequential flooding is the CDN's job, which is what the
// `Cache-Control` below is for.

/** Names the WORK, and it is a constant because the feed has no variants — one document for the
 *  whole platform, the same one for every caller. */
const FEED_BUILD_KEY = 'feed:products.xml';

export async function GET(_ctx: APIContext): Promise<Response> {
  const xml = await singleFlight(FEED_BUILD_KEY, buildFeedXml);
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Feeds are pulled infrequently; let a CDN/proxy hold it briefly.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

async function buildFeedXml(): Promise<string> {
  const baseUrl = stripTrailingSlashes(platform.url);
  const items: FeedItem[] = [];

  const stores = await getIndexableStores();
  // ONE query for every store's sold-units, ahead of the loop. Per-store inside it was a file
  // read before and would be a round trip per store now — the N+1 shape §8 flagged when
  // `store-categories` moved, in the very next module (DB_MIGRATION_PLAN.md §8).
  const purchasedByStore = await getPurchasedCountsByStoreSlugs(stores.map((s) => s.slug));

  // **The rest of that same N+1, finished (2026-08-03).** The note above batched the purchase
  // counts and left the other two reads inside the loop — a category tree and a catalogue per
  // store, in series. Measured: 45 stores took this endpoint to **6.1 seconds**, which is the
  // shape §7.16 warns about and long enough that Merchant Center's own fetch can give up on the
  // feed entirely. Two statements now, whatever the platform grows to.
  const storeIds = stores.map((s) => s.id);
  const [categoriesByStore, productsByStore] = await Promise.all([
    getCategoriesByStoreIds(storeIds),
    getVisibleProductsByStoreIds(storeIds),
  ]);

  for (const store of stores) {
    const categories = categoriesByStore.get(store.id) ?? [];
    const purchased = purchasedByStore.get(store.slug) ?? {};
    for (const product of productsByStore.get(store.id) ?? []) {
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
  }

  return toMerchantXml(items, {
    title: `${platform.name} — Product feed`,
    link: baseUrl,
    description: `Product catalog feed for ${platform.name} (Google Merchant Center / Meta Catalog).`,
    currency: platform.business.currency,
  });
}
