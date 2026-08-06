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

const ALL_STORES = [
  { id: 's1', slug: 'acme', createdAt: '2026-01-02T09:00:00.000Z' },
  { id: 's2', slug: 'showcase-fashion', createdAt: '2026-01-03T09:00:00.000Z', demo: true },
  // On its own verified domain — excluded from the platform's copy, and the subject of the
  // custom-host case below.
  {
    id: 's3', slug: 'boots', createdAt: '2026-01-04T09:00:00.000Z',
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

/** A request context carrying just the Host header, which is all this route reads of it. */
const ctxOn = (host: string) =>
  ({ request: new Request('https://x/sitemap-content.xml', { headers: { host } }) }) as never;

describe('/sitemap-content.xml', () => {
  it('serves valid XML and covers both store and product pages', async () => {
    const res = await GET(ctxOn('dezabin.co.il'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');

    const xml = await res.text();
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
    const xml = await (await GET(ctxOn('dezabin.co.il'))).text();
    expect(xml).not.toContain('showcase-fashion');
    expect(xml).not.toContain('demo-shirt');
  });

  it('leaves a store on its own domain out of the PLATFORM copy', async () => {
    // Its platform URLs 301 to that domain, and a sitemap of redirects is a sitemap of nothing.
    const xml = await (await GET(ctxOn('dezabin.co.il'))).text();
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
});
