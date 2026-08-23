import { describe, it, expect, vi } from 'vitest';
import { isDemoStore } from '../src/lib/demo-stores.js';
import { isStoreDiscoverable } from '../src/lib/store-status.js';

// GUARDRAIL for the regression that shipped once and hid: store + product pages
// are SSR (prerender=false), so @astrojs/sitemap never lists them and they were
// invisible to Google. The dynamic /sitemap-content.xml endpoint is what covers
// them now. This test mocks the data layer (so it's data-independent) and asserts
// the endpoint actually emits a store URL AND a product URL nested under it. If
// anyone breaks the enumeration — or a future change drops these routes from the
// sitemap again — this fails loudly instead of silently costing indexation.
//
// The fixture deliberately contains a showcase store (`demo: true`) too, and
// `getIndexableStores` is mocked to compose the REAL filter over the fixture —
// only the fs layer is faked. So the demo assertion below tests the route + the
// actual rule, not the mock (see lib/demo-stores.ts).

// `publishedAt` on every row, and stated rather than defaulted: `isStoreDiscoverable` is the real
// rule here, and it reads a missing one as "built and never published" — which is undiscoverable,
// correctly, and would empty this sitemap for a reason that has nothing to do with what it asserts.
const LIVE = '2026-01-01T00:00:00.000Z';
const ALL_STORES = [
  { id: 's1', slug: 'acme', createdAt: '2026-01-02T09:00:00.000Z', publishedAt: LIVE },
  { id: 's2', slug: 'showcase-fashion', createdAt: '2026-01-03T09:00:00.000Z', publishedAt: LIVE, demo: true },
  // On its own verified domain — excluded from the platform's copy, and the subject of the
  // custom-host case below.
  {
    id: 's3', slug: 'boots', createdAt: '2026-01-04T09:00:00.000Z', publishedAt: LIVE,
    customDomain: { hostname: 'boots.example', status: 'active', addedAt: '2026-01-04T09:00:00.000Z' },
  },
];

vi.mock('../src/lib/stores.js', () => ({
  getIndexableStores: () => ALL_STORES.filter((s) => !isDemoStore(s)),
  getStoreByCustomDomain: (host: string) =>
    ALL_STORES.find((s) => s.customDomain?.status === 'active' && s.customDomain.hostname === host) ?? null,
  // Re-exported from the module that owns the lifecycle table, not re-implemented — the route is
  // supposed to be asking the real rule, and a stubbed `() => true` would test the stub.
  isStoreDiscoverable,
}));
vi.mock('../src/lib/store-products.js', () => ({
  // One query for the whole list, not one per store — the sitemap walks every indexable store —
  // and only slug + date, which is all a <url> entry is (store-products.ts#getVisibleProductRefsByStoreIds).
  // Every requested id gets an entry.
  getVisibleProductRefsByStoreIds: (ids: string[]) => new Map(ids.map((id) => [
    id,
    id === 's1' ? [{ slug: 'blue-widget', createdAt: '2026-03-04T09:00:00.000Z' }]
    : id === 's2' ? [{ slug: 'demo-shirt', createdAt: '2026-03-05T09:00:00.000Z' }]
    : id === 's3' ? [{ slug: 'ankle-boot', createdAt: '2026-03-06T09:00:00.000Z' }]
    : [],
  ])),
}));

import { GET } from '../src/pages/sitemap-content.xml';
import { GET as shardGET } from '../src/pages/sitemap-content-[shard].xml';
import { platformSitemapEntries } from '../src/lib/sitemap-document.js';
import { buildUrlSetXml } from '../src/lib/sitemap.js';
import { newBuildStats } from '../src/lib/catalog-build.js';

/** A request context carrying just the Host header, which is all this route reads of it. */
const ctxOn = (host: string) =>
  ({ request: new Request('https://x/sitemap-content.xml', { headers: { host } }) }) as never;

/**
 * The platform copy, as the job would write it.
 *
 * It moved out of the route on 2026-08-09 — the route streams what a job pre-built, because
 * assembling the whole mall inside a request blocked the one event loop every shopper shares
 * (GO_LIVE §7). So these assertions follow the enumeration to `sitemap-document.ts`; what they
 * assert is unchanged, which is the point. The custom-domain case below still goes through `GET`,
 * because that branch is still answered live.
 */
async function platformXml(): Promise<string> {
  const entries = [];
  for await (const entry of platformSitemapEntries(newBuildStats())) entries.push(entry);
  return buildUrlSetXml(entries);
}

describe('/sitemap-content.xml', () => {
  it('serves valid XML and covers both store and product pages', async () => {
    const xml = await platformXml();
    expect(xml).toContain('<urlset');
    // The store page must be present… (root-level store URL: /<slug>)
    expect(xml).toMatch(/<loc>https?:\/\/[^<]*\/acme<\/loc>/);
    // …and its product page (nested under the store slug) — the whole point.
    expect(xml).toMatch(/<loc>https?:\/\/[^<]*\/acme\/blue-widget<\/loc>/);
    // lastmod is derived from createdAt (date part only).
    expect(xml).toContain('<lastmod>2026-03-04</lastmod>');
  });

  it('never advertises a showcase store or its products', async () => {
    // Fabricated catalog in Google's index costs the shared platform domain real
    // ranking — the reason showcase stores are noindex on-page as well.
    const xml = await platformXml();
    expect(xml).not.toContain('showcase-fashion');
    expect(xml).not.toContain('demo-shirt');
  });

  it('leaves a store on its own domain out of the PLATFORM copy', async () => {
    // Its platform URLs 301 to that domain, and a sitemap of redirects is a sitemap of nothing.
    const xml = await platformXml();
    expect(xml).not.toContain('/boots');
  });

  it("serves that store its OWN sitemap on its OWN domain, rooted there", async () => {
    // A sitemap may only list URLs on the host serving it, so this is the only place these URLs can
    // legally appear — and until 2026-08-06 they appeared nowhere: excluded from ours, absent from
    // theirs. The store lives at the ROOT of its domain, so no `/boots` prefix.
    const xml = await (await GET(ctxOn('boots.example'))).text();
    expect(xml).toContain('<loc>https://boots.example/</loc>');
    expect(xml).toContain('<loc>https://boots.example/ankle-boot</loc>');
    // And nothing from the rest of the mall — cross-host entries are what makes a sitemap invalid.
    expect(xml).not.toContain('acme');
    expect(xml).not.toContain('dezabin.co.il');
  });

  it('refuses to serve a PLATFORM shard from a seller domain', async () => {
    // A path with a dot passes the custom-domain rewrite through untouched, so `/sitemap-content-1.xml`
    // reaches the shard route on shop.acme.co.il as easily as on ours. Serving it there would put the
    // platform's URLs in a sitemap hosted on a domain that owns none of them — invalid by the
    // protocol, and the exact boundary robots.txt.ts was rewritten to hold. That domain's sitemap is
    // its own single file, asserted above.
    const res = await shardGET({ params: { shard: '1' }, request: new Request('https://x/sitemap-content-1.xml', { headers: { host: 'boots.example' } }) } as never);
    expect(res.status).toBe(404);
  });

  /**
   * **The boundary is the HOST, not whether a store answers to it** — the finding of the 2026-08-21
   * area audit of the SEO surfaces, and the reason these two cases are pinned rather than left to
   * the two routes to agree about.
   *
   * The rule sitemaps.org states is that every URL in a sitemap is on the same host as the sitemap.
   * Three files each held part of it and they disagreed: the shard route refused only a MATCHED
   * custom-domain host, the index route refused only when it could build that host's own document,
   * and `robots.txt` named the platform's two sitemaps on anything it did not recognise. So a seller
   * whose store was merely PAUSED — a real, verified, crawled hostname — was served the platform's
   * sitemap index from their own domain, pointing at a shard that 404s on that same domain.
   * Reproduced against the built server before this was written.
   */
  it('serves NO platform sitemap on a host that has no sitemap of its own', async () => {
    // The paused/closed/not-ready case: the host IS a seller's, `customHostSitemap` returns null,
    // and the platform's document must not stand in for the one this host does not have.
    const res = await GET(ctxOn('someone-elses.example'));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('dezabin.co.il');
  });

  it('serves no platform SHARD on a foreign host either, matched or not', async () => {
    const res = await shardGET({ params: { shard: '1' }, request: new Request('https://x/sitemap-content-1.xml', { headers: { host: 'someone-elses.example' } }) } as never);
    expect(res.status).toBe(404);
  });
});
