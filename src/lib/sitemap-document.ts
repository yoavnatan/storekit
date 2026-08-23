/**
 * The platform's content sitemap, produced a piece at a time — and the shared definition of what a
 * store's crawlable surface IS.
 *
 * **Why the enumeration left the route.** `/sitemap-content.xml` walked every indexable store,
 * every visible product and every category tree into one string inside the request; it is now built
 * by a job into storage (`artifacts.ts`, migration 0022) and the route serves it. Nothing about
 * which URLs are listed changed — see `feed-document.ts` for the same move and the reasoning behind
 * the batching and the generator.
 *
 * **`storeEntries` stayed shared, and that is the important part.** It is used twice: by the
 * platform build below, and by the route's custom-domain branch, where a seller's own host serves
 * the sitemap of that one store rooted at `/`. `origin` + `prefix` are the whole difference between
 * them. One store's shelf is bounded work and is still built in the request — there is nothing to
 * pre-build and nothing to share. The alternative was two lists that agree until someone adds a
 * page type to one of them.
 */
import type { Store } from './stores.js';
import { getIndexableStores } from './stores.js';
import { getVisibleProductRefsByStoreIds, type ProductRef } from './store-products.js';
import { getCategoriesByStoreIds, countProductsPerCategory, categoryUrlParam, type StoreCategory } from './store-categories.js';
import { store as platform } from '../config/store.config.js';
import { toSitemapDate, type SitemapEntry } from './sitemap.js';
import { isStoreReady } from './store-readiness.js';
import { stripTrailingSlashes, urlSegment } from './url-base.js';
import { batches, STORE_BATCH, type CatalogBuildStats } from './catalog-build.js';
import { HELP_ARTICLES } from './help-articles.js';

/**
 * One store's URLs, rooted wherever the store is being served from.
 *
 * On the platform a store lives at `/<slug>/…`; on its own verified domain it lives at the root
 * (`resolveCustomDomainRewrite`). Same entries, same priorities, one place that decides them.
 */
export function storeEntries(
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
 * What ONE store contributes to the platform's copy, or `null` if it belongs in no sitemap of ours.
 *
 * Exported for the same reason `storeFeedItems` is: this is the whole per-store policy, and
 * `tests/catalog-artifacts.test.ts` composes its expected document from it, so the streamed
 * document can be compared byte for byte against a single-shot one without the test carrying a
 * second copy of the rules.
 */
export function platformStoreEntries(
  s: Store,
  products: readonly ProductRef[],
  categories: StoreCategory[],
  baseUrl: string,
): SitemapEntry[] | null {
  // A store on a verified custom domain lives on THAT domain now — its platform URLs 301 there, so
  // listing them in the platform sitemap would just advertise redirects. Its own domain is crawled
  // via the platform's discovery links + the 301s (and gets its own sitemap there). Skip it here.
  if (s.customDomain?.status === 'active') return null;
  // A store with nothing to buy is an empty shell — advertising it to Google earns the
  // platform domain a thin/soft-404 page for no gain (see lib/store-readiness.ts).
  if (!isStoreReady({ visibleProductCount: products.length })) return null;
  return storeEntries(s, products, categories, baseUrl, `/${urlSegment(s.slug)}`);
}

/**
 * The platform's own indexable pages. Exported so `tests/sitemap-content.test.ts` can assert the
 * list rather than re-derive it, and pure so it needs no database.
 *
 * Priorities are relative and only compared within this document: the homepage is the entry to
 * everything (1.0), the directory and the pricing page are the two a seller or a shopper arrives on
 * from a search (0.8/0.7), help articles are long-tail answers (0.5), and the policy pages exist to
 * be READ when linked rather than to be found (0.3) — they still have to be listed, because
 * Merchant Center looks for a published returns policy and terms.
 */
export function platformPageEntries(baseUrl: string): SitemapEntry[] {
  return [
    { loc: `${baseUrl}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${baseUrl}/stores`, changefreq: 'daily', priority: '0.8' },
    { loc: `${baseUrl}/pricing`, changefreq: 'monthly', priority: '0.7' },
    { loc: `${baseUrl}/help`, changefreq: 'monthly', priority: '0.6' },
    ...HELP_ARTICLES.map((a): SitemapEntry => ({
      loc: `${baseUrl}/help/${a.slug}`, changefreq: 'monthly', priority: '0.5',
    })),
    { loc: `${baseUrl}/terms`, changefreq: 'yearly', priority: '0.3' },
    { loc: `${baseUrl}/returns-policy`, changefreq: 'yearly', priority: '0.3' },
    { loc: `${baseUrl}/contact`, changefreq: 'yearly', priority: '0.3' },
  ];
}

/**
 * Every URL the platform's sitemap lists, in order, one at a time.
 *
 * **Entries and not XML, unlike the feed's builder** — because this document is SHARDED. A sitemap
 * file may hold 45,000 URLs (`SITEMAP_MAX_URLS`), so the writer has to count them and decide where
 * one file ends and the next begins; handing it finished `<url>` blocks would mean counting
 * newlines. The serialising happens one level up, in `catalog-artifacts.ts`, which is also the only
 * place that knows what a shard is called.
 *
 * `stats.stores` counts the stores actually LISTED (a store that fails readiness or lives on its own
 * domain is walked and skipped), `stats.items` the entries yielded.
 */
export async function* platformSitemapEntries(stats: CatalogBuildStats): AsyncGenerator<SitemapEntry> {
  const baseUrl = stripTrailingSlashes(platform.url);

  // ── The platform's OWN pages, before anybody's shop (2026-08-23) ──
  // They were in no sitemap at all, and it went unnoticed because each half looked complete. The
  // static sitemap (`@astrojs/sitemap`) only sees routes that exist at BUILD time, and every page
  // in `src/pages` is `prerender = false`; this document only ever listed stores and products. So
  // the homepage, the directory and every policy page were reachable by crawl and advertised by
  // nothing — the "valid sitemap, no error, missing URLs" class the SEO rule warns about, which is
  // exactly why that rule says to check the BUILT output rather than the page tags.
  //
  // Listed here rather than in the static sitemap's config because this is the document that can
  // hold an SSR route. The list is the indexable complement of `astro.config.mjs`'s sitemap filter:
  // no /admin, /seller, /buyer, /checkout or /review (private), and no /search, /store-gone or
  // /store-unavailable (they render `noindex`, and advertising a noindex URL is the "submitted URL
  // marked noindex" contradiction Search Console reports).
  //
  // `/help/<slug>` comes off the corpus rather than being typed, so a new article is listed by
  // writing it.
  for (const entry of platformPageEntries(baseUrl)) {
    stats.items++;
    yield entry;
  }

  const indexableStores = await getIndexableStores();

  for (const batch of batches(indexableStores, STORE_BATCH)) {
    const storeIds = batch.map((s) => s.id);
    // Only slug + date + category id, which is all a `<url>` entry needs: reading whole products
    // here shipped every description, tag, spec and image array across the network to write two
    // strings each. The two reads are independent, so they overlap instead of adding up.
    const [productsByStore, categoriesByStore] = await Promise.all([
      getVisibleProductRefsByStoreIds(storeIds),
      getCategoriesByStoreIds(storeIds),
    ]);

    for (const s of batch) {
      const entries = platformStoreEntries(s, productsByStore.get(s.id) ?? [], categoriesByStore.get(s.id) ?? [], baseUrl);
      if (!entries) continue;

      stats.stores++;
      for (const entry of entries) {
        stats.items++;
        yield entry;
      }
    }
  }
}
