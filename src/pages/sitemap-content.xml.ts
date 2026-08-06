export const prerender = false;
import type { APIContext } from 'astro';
import { getIndexableStores, getStoreByCustomDomain, isStoreDiscoverable, type Store } from '../lib/stores.js';
import { isDemoStore } from '../lib/demo-stores.js';
import { isPlatformHost } from '../lib/custom-domain.js';
import { getVisibleProductRefsByStoreIds, type ProductRef } from '../lib/store-products.js';
import { store as platform } from '../config/store.config.js';
import { buildUrlSetXml, toSitemapDate, type SitemapEntry } from '../lib/sitemap.js';
import { isStoreReady } from '../lib/store-readiness.js';
import { getCategoriesByStoreIds, countProductsPerCategory, categoryUrlParam, type StoreCategory } from '../lib/store-categories.js';
import { stripTrailingSlashes, urlSegment } from '../lib/url-base.js';
import { singleFlight } from '../lib/single-flight.js';

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

/**
 * One store's URLs, rooted wherever the store is being served from.
 *
 * `origin` + `prefix` are the whole difference between the platform's copy of this sitemap and the
 * one a seller's own domain serves: on the platform a store lives at `/<slug>/…`, and on its own
 * domain it lives at the root (`resolveCustomDomainRewrite`). Same entries, same priorities, and
 * one place that decides what a store's crawlable surface IS — the alternative was two lists that
 * agree until someone adds a page type to one of them.
 */
function storeEntries(
  s: Pick<Store, 'slug' | 'createdAt'>,
  products: readonly ProductRef[],
  categories: StoreCategory[],
  origin: string,
  prefix: string,
): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  // Percent-encoded per segment: product slugs carry Hebrew, and the sitemap protocol requires
  // <loc> to be an escaped URL — an unencoded one is a validation error, not a rendering nicety.
  entries.push({
    loc: `${origin}${prefix || '/'}`,
    lastmod: toSitemapDate(s.createdAt),
    changefreq: 'daily',
    priority: '0.8',
  });
  for (const p of products) {
    entries.push({
      loc: `${origin}${prefix}/${urlSegment(p.slug)}`,
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
  // advertising one earns the domain a thin page for no gain — the same call `isStoreReady` makes
  // one level up.
  if (categories.length) {
    const counts = countProductsPerCategory(categories, products.map((p) => p.categoryId));
    for (const c of categories) {
      if ((counts[c.id] ?? 0) === 0) continue;
      entries.push({
        loc: `${origin}${prefix || '/'}?category=${urlSegment(categoryUrlParam(c))}`,
        lastmod: toSitemapDate(s.createdAt),
        changefreq: 'weekly',
        priority: '0.75',
      });
    }
  }
  return entries;
}

/**
 * A store on its OWN domain gets its own sitemap, served from that domain.
 *
 * It is excluded from the platform's copy below (its platform URLs 301 away, and a sitemap of
 * redirects is a sitemap of nothing) — which used to leave it with no sitemap anywhere. A sitemap
 * may only list URLs on the host that serves it, so the seller's domain cannot appear in ours and
 * ours cannot appear in theirs: the only correct answer is this one, and the same `/sitemap-content.xml`
 * path already resolves on a custom host (a path with a dot passes the rewrite through untouched).
 *
 * This is also what makes a domain switch invisible to a crawler in BOTH directions: whichever
 * domain the store is on today is the domain whose sitemap lists it, without anything to migrate.
 */
async function customHostSitemap(host: string): Promise<Response | null> {
  const store = await getStoreByCustomDomain(host.toLowerCase().replace(/:\d+$/, '').trim());
  // The same gates the platform copy applies — a store that is paused, closed, blocked, fabricated
  // or empty must not be advertised from its own domain either. `isStoreDiscoverable`, not a hand-
  // rolled flag read: the lifecycle rules are one table (`store-status.ts`) and a second reading of
  // them is what `tests/store-lifecycle-guard.test.ts` exists to refuse — it caught this exact line.
  if (!store || !isStoreDiscoverable(store) || isDemoStore(store)) return null;
  const [productsByStore, categoriesByStore] = await Promise.all([
    getVisibleProductRefsByStoreIds([store.id]),
    getCategoriesByStoreIds([store.id]),
  ]);
  const products = productsByStore.get(store.id) ?? [];
  if (!isStoreReady({ visibleProductCount: products.length })) return null;
  const entries = storeEntries(store, products, categoriesByStore.get(store.id) ?? [], `https://${store.customDomain!.hostname}`, '');
  return xmlResponse(buildUrlSetXml(entries));
}

export async function GET(ctx: APIContext): Promise<Response> {
  const host = ctx.request.headers.get('host') ?? '';
  if (host && !isPlatformHost(host)) {
    const own = await customHostSitemap(host);
    // A host we do not recognise falls through to the platform sitemap rather than 404-ing: the
    // request reached us somehow, and answering it with the platform's own URLs is never wrong.
    if (own) return own;
  }

  // **Concurrent crawls share one build (`lib/single-flight.ts`).** Same reasoning, same class and
  // the same measurement as `api/feed/products.xml`: public, unauthenticated, and it walks the WHOLE
  // mall into one string on a single event loop, so while it runs every other request in the process
  // — a shopper at checkout included — is waiting behind it. Googlebot, Bingbot and a `curl` loop are
  // three simultaneous full-mall builds without this and one with it. Only the platform-wide branch
  // is guarded; the custom-host branch above is one store's shelf and costs nothing worth sharing.
  return xmlResponse(await singleFlight(PLATFORM_SITEMAP_KEY, buildPlatformSitemapXml));
}

/** Names the WORK. Constant because the platform sitemap has no variants — the per-host answers
 *  returned above never reach here. */
const PLATFORM_SITEMAP_KEY = 'sitemap:platform';

async function buildPlatformSitemapXml(): Promise<string> {
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
    entries.push(...storeEntries(s, visibleProducts, categoriesByStore.get(s.id) ?? [], baseUrl, `/${urlSegment(s.slug)}`));
  }

  return buildUrlSetXml(entries);
}

/** Takes the finished document rather than the entries: the platform branch builds its XML inside
 *  `singleFlight` (so the string, not the entry array, is what concurrent callers share). */
function xmlResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
