import { describe, it, expect, vi } from 'vitest';
import { isDemoStore } from '../src/lib/demo-stores.js';

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
];

vi.mock('../src/lib/stores.js', () => ({
  getIndexableStores: () => ALL_STORES.filter((s) => !isDemoStore(s)),
}));
vi.mock('../src/lib/store-products.js', () => ({
  // One query for the whole list, not one per store — the sitemap walks every indexable store
  // (store-products.ts#getVisibleProductsByStoreIds). Every requested id gets an entry.
  getVisibleProductsByStoreIds: (ids: string[]) => new Map(ids.map((id) => [
    id,
    id === 's1' ? [{ slug: 'blue-widget', createdAt: '2026-03-04T09:00:00.000Z' }]
    : id === 's2' ? [{ slug: 'demo-shirt', createdAt: '2026-03-05T09:00:00.000Z' }]
    : [],
  ])),
}));

import { GET } from '../src/pages/sitemap-content.xml';

describe('/sitemap-content.xml', () => {
  it('serves valid XML and covers both store and product pages', async () => {
    const res = await GET({} as never);
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
    const xml = await (await GET({} as never)).text();
    expect(xml).not.toContain('showcase-fashion');
    expect(xml).not.toContain('demo-shirt');
  });
});
