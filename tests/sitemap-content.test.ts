import { describe, it, expect, vi } from 'vitest';

// GUARDRAIL for the regression that shipped once and hid: store + product pages
// are SSR (prerender=false), so @astrojs/sitemap never lists them and they were
// invisible to Google. The dynamic /sitemap-content.xml endpoint is what covers
// them now. This test mocks the data layer (so it's data-independent) and asserts
// the endpoint actually emits a store URL AND a product URL nested under it. If
// anyone breaks the enumeration — or a future change drops these routes from the
// sitemap again — this fails loudly instead of silently costing indexation.

vi.mock('../src/lib/stores.js', () => ({
  getVisibleStores: () => [{ id: 's1', slug: 'acme', createdAt: '2026-01-02T09:00:00.000Z' }],
}));
vi.mock('../src/lib/store-products.js', () => ({
  getVisibleProductsByStoreId: (id: string) =>
    id === 's1' ? [{ slug: 'blue-widget', createdAt: '2026-03-04T09:00:00.000Z' }] : [],
}));

import { GET } from '../src/pages/sitemap-content.xml';

describe('/sitemap-content.xml', () => {
  it('serves valid XML and covers both store and product pages', async () => {
    const res = await GET({} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('xml');

    const xml = await res.text();
    expect(xml).toContain('<urlset');
    // The store page must be present…
    expect(xml).toMatch(/<loc>https?:\/\/[^<]*\/store\/acme<\/loc>/);
    // …and its product page (nested under the store slug) — the whole point.
    expect(xml).toMatch(/<loc>https?:\/\/[^<]*\/store\/acme\/blue-widget<\/loc>/);
    // lastmod is derived from createdAt (date part only).
    expect(xml).toContain('<lastmod>2026-03-04</lastmod>');
  });
});
