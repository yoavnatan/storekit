export const prerender = false;
import type { APIContext } from 'astro';
import { getIndexableStores } from '../lib/stores.js';
import { getVisibleProductRefsByStoreIds } from '../lib/store-products.js';
import { store as platform } from '../config/store.config.js';
import { buildUrlSetXml, toSitemapDate, type SitemapEntry } from '../lib/sitemap.js';
import { isStoreReady } from '../lib/store-readiness.js';
import { getCategoriesByStoreIds, countProductsPerCategory, categoryUrlParam } from '../lib/store-categories.js';
import { stripTrailingSlashes, urlSegment } from '../lib/url-base.js';

// Dynamic content sitemap for the SEO pages that @astrojs/sitemap CANNOT see:
// every store page (/[slug]) and product page (/[slug]/[product]) is
// SSR (`prerender = false`), so it isn't a build-time route and never lands in
// the static sitemap. Google therefore only discovers these — the actual ranking
// pages — through in-page <a href> links, which don't reach products past a
// store's first grid page. This URL closes that gap: it lists all of them,
// straight from live data, so it stays current as sellers add/edit/remove.
//
// Referenced from robots.txt alongside the static sitemap-index.xml (Google
// supports multiple `Sitemap:` directives). Only visible (non-blocked, non-demo)
// stores and products are emitted — a blocked listing must not be advertised to
// search engines, and the platform's own showcase stores (lib/demo-stores.ts)
// are fabricated catalog that would cost the shared domain real ranking. Same
// `await getIndexableStores()` gate the product feed and llms.txt use.
//
// Scale note (JSON-file era): rebuilt per request. Fine at current volume with
// the 1h cache below; at DB-migration time this becomes a cached/generated
// artifact with the same output shape.

export async function GET(_ctx: APIContext): Promise<Response> {
  const baseUrl = stripTrailingSlashes(platform.url);
  const entries: SitemapEntry[] = [];

  const indexableStores = await getIndexableStores();
  // One query for every store's shelf, not one per store — the sitemap walks the WHOLE mall. And
  // only slug + date, which is all a <url> entry is: reading whole products here shipped every
  // description, tag, spec and image array across the network to write two strings each.
  //
  // The category trees are read the same way and for the same reason: the per-store reader inside
  // the loop below would be one sequential round trip per store on the exact request that touches
  // every store there is. That is the cost `getCategoriesByStoreIds` was written for — the product
  // feed hit six seconds at 45 stores doing it per-store — and the two queries are independent, so
  // they overlap instead of adding up.
  const storeIds = indexableStores.map((s) => s.id);
  const [productsByStore, categoriesByStore] = await Promise.all([
    getVisibleProductRefsByStoreIds(storeIds),
    getCategoriesByStoreIds(storeIds),
  ]);

  for (const s of indexableStores) {
    // A store on a verified custom domain lives on THAT domain now — its platform URLs 301 there, so
    // listing them in the platform sitemap would just advertise redirects. Its own domain is crawled
    // via the platform's discovery links + the 301s. Skip it here.
    if (s.customDomain?.status === 'active') continue;
    // A store with nothing to buy is an empty shell — advertising it to Google earns the
    // platform domain a thin/soft-404 page for no gain (see lib/store-readiness.ts).
    const visibleProducts = productsByStore.get(s.id) ?? [];
    if (!isStoreReady({ visibleProductCount: visibleProducts.length })) continue;
    // Percent-encoded per segment: product slugs carry Hebrew, and the sitemap protocol requires
    // <loc> to be an escaped URL — an unencoded one is a validation error, not a rendering nicety.
    entries.push({
      loc: `${baseUrl}/${urlSegment(s.slug)}`,
      lastmod: toSitemapDate(s.createdAt),
      changefreq: 'daily',
      priority: '0.8',
    });
    for (const p of visibleProducts) {
      entries.push({
        loc: `${baseUrl}/${urlSegment(s.slug)}/${urlSegment(p.slug)}`,
        lastmod: toSitemapDate(p.createdAt),
        changefreq: 'weekly',
        priority: '0.7',
      });
    }

    // Category pages. They became real URLs on 2026-08-03 — before that the filter was a <button>,
    // so a category was a piece of client state with nothing to list. Each one is a genuine page a
    // person searches for ("נעליים" inside a named store) and it sits between the store and its
    // products in the tree, which is what the priority below says.
    //
    // Only categories that HOLD something. An empty category is a shelf with nothing on it, and
    // advertising one earns the shared platform domain a thin page for no gain — the same call
    // `isStoreReady` makes one level up.
    const categories = categoriesByStore.get(s.id) ?? [];
    if (categories.length) {
      const counts = countProductsPerCategory(categories, visibleProducts.map((p) => p.categoryId));
      for (const c of categories) {
        if ((counts[c.id] ?? 0) === 0) continue;
        entries.push({
          loc: `${baseUrl}/${urlSegment(s.slug)}?category=${urlSegment(categoryUrlParam(c))}`,
          lastmod: toSitemapDate(s.createdAt),
          changefreq: 'weekly',
          priority: '0.75',
        });
      }
    }
  }

  return new Response(buildUrlSetXml(entries), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
