export const prerender = false;
import type { APIContext } from 'astro';
import { getIndexableStores } from '../lib/stores.js';
import { getVisibleProductsByStoreId } from '../lib/store-products.js';
import { store as platform } from '../config/store.config.js';
import { buildUrlSetXml, toSitemapDate, type SitemapEntry } from '../lib/sitemap.js';
import { isStoreReady } from '../lib/store-readiness.js';

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
// `getIndexableStores()` gate the product feed and llms.txt use.
//
// Scale note (JSON-file era): rebuilt per request. Fine at current volume with
// the 1h cache below; at DB-migration time this becomes a cached/generated
// artifact with the same output shape.

export async function GET(_ctx: APIContext): Promise<Response> {
  const baseUrl = platform.url.replace(/\/+$/, '');
  const entries: SitemapEntry[] = [];

  for (const s of getIndexableStores()) {
    // A store on a verified custom domain lives on THAT domain now — its platform URLs 301 there, so
    // listing them in the platform sitemap would just advertise redirects. Its own domain is crawled
    // via the platform's discovery links + the 301s. Skip it here.
    if (s.customDomain?.status === 'active') continue;
    // A store with nothing to buy is an empty shell — advertising it to Google earns the
    // platform domain a thin/soft-404 page for no gain (see lib/store-readiness.ts).
    const visibleProducts = getVisibleProductsByStoreId(s.id);
    if (!isStoreReady({ visibleProductCount: visibleProducts.length })) continue;
    entries.push({
      loc: `${baseUrl}/${s.slug}`,
      lastmod: toSitemapDate(s.createdAt),
      changefreq: 'daily',
      priority: '0.8',
    });
    for (const p of visibleProducts) {
      entries.push({
        loc: `${baseUrl}/${s.slug}/${p.slug}`,
        lastmod: toSitemapDate(p.createdAt),
        changefreq: 'weekly',
        priority: '0.7',
      });
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
