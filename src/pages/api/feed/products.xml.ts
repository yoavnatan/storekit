export const prerender = false;
import type { APIContext } from 'astro';
import { getIndexableStores } from '../../../lib/stores.js';
import { getVisibleProductsByStoreId } from '../../../lib/store-products.js';
import { getCategoriesByStoreId, categoryPath } from '../../../lib/store-categories.js';
import { getPurchasedCountsByStoreSlug } from '../../../lib/orders.js';
import { store as platform } from '../../../config/store.config.js';
import { buildFeedItems, toMerchantXml, type FeedItem } from '../../../lib/product-feed.js';
import { stripTrailingSlashes } from '../../../lib/url-base.js';

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

export async function GET(_ctx: APIContext): Promise<Response> {
  const baseUrl = stripTrailingSlashes(platform.url);
  const items: FeedItem[] = [];

  for (const store of await getIndexableStores()) {
    const categories = await getCategoriesByStoreId(store.id);
    const purchased = getPurchasedCountsByStoreSlug(store.slug);
    for (const product of getVisibleProductsByStoreId(store.id)) {
      const cPath = product.categoryId ? categoryPath(categories, product.categoryId) : undefined;
      items.push(...buildFeedItems(product, {
        storeName: store.name,
        storeSlug: store.slug,
        baseUrl,
        categoryPath: cPath,
        purchasedUnits: purchased[product.id],
        storeTags: store.categories,
        sale: store.sale,
      }));
    }
  }

  const xml = toMerchantXml(items, {
    title: `${platform.name} — Product feed`,
    link: baseUrl,
    description: `Product catalog feed for ${platform.name} (Google Merchant Center / Meta Catalog).`,
    currency: platform.business.currency,
  });

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Feeds are pulled infrequently; let a CDN/proxy hold it briefly.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
