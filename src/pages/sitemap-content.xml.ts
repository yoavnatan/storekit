export const prerender = false;
import type { APIContext } from 'astro';
import { getStoreByCustomDomain, isStoreDiscoverable } from '../lib/stores.js';
import { isDemoStore } from '../lib/demo-stores.js';
import { isPlatformHost } from '../lib/custom-domain.js';
import { getVisibleProductRefsByStoreIds } from '../lib/store-products.js';
import { buildUrlSetXml } from '../lib/sitemap.js';
import { isStoreReady } from '../lib/store-readiness.js';
import { getCategoriesByStoreIds } from '../lib/store-categories.js';
import { storeEntries } from '../lib/sitemap-document.js';
import { serveCatalogArtifact, notFound, SITEMAP_ARTIFACT, CATALOG_ARTIFACT_INTERVAL_SEC } from '../lib/catalog-artifacts.js';

// Dynamic content sitemap for the SEO pages that @astrojs/sitemap CANNOT see:
// every store page (/[slug]) and product page (/[slug]/[product]) is
// SSR (`prerender = false`), so it isn't a build-time route and never lands in
// the static sitemap. Google therefore only discovers these — the actual ranking
// pages — through in-page <a href> links, which don't reach products past a
// store's first grid page. This URL closes that gap: it lists all of them, so it
// stays current as sellers add/edit/remove.
//
// Referenced from robots.txt alongside the static sitemap-index.xml (Google
// supports multiple `Sitemap:` directives). Only visible (non-blocked, non-demo)
// stores and products are emitted — a blocked listing must not be advertised to
// search engines, and the platform's own showcase stores (lib/demo-stores.ts)
// are fabricated catalog that would cost the shared domain real ranking.
//
// **On the platform host this now serves a `<sitemapindex>` (2026-08-09).** Two
// changes at once, and they belong together. It used to walk the whole mall into
// one string inside the request, on the single event loop every shopper shares —
// the same shape, measurement and fix as the product feed (see
// `api/feed/products.xml.ts` and GO_LIVE §7): the `sitemap-artifact` job builds
// it, `artifacts.ts` stores it, this route streams it. And the URLs themselves
// moved into numbered shards (`sitemap-content-[shard].xml.ts`), because one
// sitemap file may hold no more than 50,000 URLs and a mall of a thousand
// sellers passes that — over the limit Google rejects the file WHOLE, so the
// symptom would have been a platform with no content sitemap and no error
// anywhere. The index is served even when there is one shard: a document shape
// that changes by itself the first time a threshold is crossed is one nobody has
// ever seen work.
//
// The custom-domain branch below is still built per request, and that is not an
// oversight: it is ONE store's shelf, bounded by that store's catalogue, and it
// is keyed by a host the platform build knows nothing about.

/**
 * A store on its OWN domain gets its own sitemap, served from that domain.
 *
 * It is excluded from the platform's copy (its platform URLs 301 away, and a sitemap of redirects
 * is a sitemap of nothing) — which used to leave it with no sitemap anywhere. A sitemap may only
 * list URLs on the host that serves it, so the seller's domain cannot appear in ours and ours
 * cannot appear in theirs: the only correct answer is this one, and the same `/sitemap-content.xml`
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
  return new Response(buildUrlSetXml(entries), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // The same window the platform copy publishes, so one store's sitemap is never fresher or
      // staler than the mall's by accident.
      'Cache-Control': `public, max-age=${CATALOG_ARTIFACT_INTERVAL_SEC}`,
    },
  });
}

/**
 * **The platform's sitemap is served on the platform's hosts, and nowhere else** (2026-08-21, area
 * audit of the SEO surfaces).
 *
 * This route used to fall through to the platform's document whenever it could not produce the
 * host's own — "the request reached us somehow, and answering it with the platform's own URLs is
 * never wrong". It is wrong, and it was wrong in three ways that only show up when the four SEO
 * surfaces are read as one:
 *
 *   · **Against the protocol.** sitemaps.org: every URL in a sitemap must be on the same host as the
 *     sitemap. So `https://acme.co.il/sitemap-content.xml` naming `dezabin.co.il` URLs is not a
 *     weaker sitemap, it is an invalid one, and Search Console reports it as such on the SELLER's
 *     property.
 *   · **Against this repo's own stated rule.** `robots.txt.ts` was rewritten precisely because "the
 *     platform's two are not this domain's to declare" — and then this route declared them.
 *   · **Against the shard route beside it**, which already refuses a matched custom-domain host. So
 *     a seller whose store is PAUSED (matched host, but `customHostSitemap` returns null for a store
 *     that is not discoverable) was served the platform's INDEX from their own domain, pointing at a
 *     shard that 404s on that same domain. Verified against the built server, not reasoned about:
 *     index 200 naming `dezabin.co.il/sitemap-content-1.xml`, shard 404.
 *
 * 404 is the honest answer: that host has no sitemap. Nothing is lost — the platform's own document
 * is reachable at the platform's host, which is the only place a crawler will believe it anyway.
 */
export async function GET(ctx: APIContext): Promise<Response> {
  const host = ctx.request.headers.get('host') ?? '';
  if (host && !isPlatformHost(host)) {
    return (await customHostSitemap(host)) ?? notFound();
  }

  return serveCatalogArtifact(SITEMAP_ARTIFACT, 'application/xml; charset=utf-8', ctx.request);
}
