/**
 * A shopper-facing store page is the STORE's page, in every slot that names it.
 *
 * The rule (owner, 2026-08-13): a shopper with six tabs open is looking at six shops, not six
 * pages of ours — so the tab's icon, the tab's TEXT and the card a shopper forwards all belong to
 * the store, and none of them says "Dezabin". The favicon half has been true since the store
 * favicon shipped; the title half was not, and the gap was invisible because each half was
 * internally consistent.
 *
 * Guarded by reading the source rather than by rendering, because the two halves live in two
 * components (`BaseLayout.astro` decides, `Seo.astro` renders) and the failure this protects
 * against is exactly them drifting apart — one gate for the icon and a different one for the
 * title, which no page-level test would call wrong.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), 'utf8');

const seo = read('components/Seo.astro');
const baseLayout = read('layouts/BaseLayout.astro');
const seoField = read('lib/product-seo-field.ts');
const storePage = read('pages/[storeSlug]/index.astro');

describe('the store owns its own title', () => {
  it('Seo.astro drops the platform suffix when the page is the store’s', () => {
    expect(seo).toContain('storeOwned');
    // The whole rule in one expression: with `storeOwned`, the title is the page's own and nothing
    // is appended to it.
    expect(seo).toMatch(/storeOwned\s*\?\s*title\s*:\s*`\$\{title\}\s*\|\s*\$\{store\.name\}`/);
  });

  it('is decided by the SAME gate as the store’s favicon, in one place', () => {
    // A second spelling of "is this a store page" is how the icon and the title end up disagreeing
    // — which is the only way this rule can half-apply.
    expect(baseLayout).toMatch(/const storeOwnsThisPage = !!storeSlug && !sellerMode;/);
    expect(baseLayout).toMatch(/const storeIcon =\s*\n\s*storeOwnsThisPage/);
    expect(baseLayout).toContain('storeOwned={storeOwnsThisPage}');
    // `storeMode` is the LAYOUT — thirteen pages of ours ask for it — so it must never become the
    // gate for ownership.
    expect(baseLayout).not.toContain('storeOwned={storeMode}');
  });

  it('the seller’s SEO preview promises the tag the page really renders', () => {
    // The dashboard shows the seller what their title will be. It said `<product> | <store>` while
    // the page rendered `<product> — <store> | Dezabin`, so it was wrong in both directions at
    // once; it is only worth anything if it stays exactly what the page emits.
    expect(seoField).toContain('`${input.name} — ${preview.storeName}`');
    expect(seoField).not.toMatch(/\$\{input\.name\}\s*\|/);
  });
});

/**
 * The name Google prints ABOVE the result — its "site name" — and the one place the platform
 * genuinely cannot hand a store its own: Google supports site names for a domain and a subdomain
 * and NOT for a subdirectory, so `dezabin.co.il/<slug>` shows ours whatever we declare
 * (developers.google.com/search/docs/appearance/site-names, checked 2026-08-13). A seller's own
 * verified domain is therefore the entire mechanism, which makes these two signals the difference
 * between a domain they paid for that says their name and one that still says ours.
 */
describe('a store on its own domain declares its own site name', () => {
  it('og:site_name follows the store on a store-owned page', () => {
    expect(seo).toContain('const resolvedSiteName = (storeOwned && siteName) || store.name;');
    expect(seo).toContain('<meta property="og:site_name" content={resolvedSiteName} />');
    expect(baseLayout).toContain('siteName={storeName}');
  });

  it('the WebSite node is emitted ONLY where Google can act on it', () => {
    // All four conditions matter and each one is a different way of publishing a claim Google
    // discards — or worse, a claim about the seller's domain from a URL that is not on it:
    // no custom domain (a subdirectory), a category or page 2 (not the home page Google reads),
    // an ad landing (a platform URL by construction).
    expect(storePage).toContain(
      'const declaresOwnSite = hasActiveCustomDomain(shopStore) && !selectedCategory && currentPage === 1 && !adLanding;',
    );
    expect(storePage).toMatch(/declaresOwnSite\s*\n?\s*\?/);
    // The Store node keeps its own `@id` so the WebSite's publisher can point at the shop rather
    // than at us — on that domain the publisher IS the shop.
    expect(storePage).toContain("'@id': `${storeUrl}#store`");
    expect(storePage).toContain("publisher: { '@id': `${storeUrl}#store` }");
    // A SearchAction here would be markup for a feature Google retired in 2023. Matched as the
    // emitted NODE, not as the word — the reasoning above names it in a comment.
    expect(storePage).not.toContain("'@type': 'SearchAction'");
  });
});
