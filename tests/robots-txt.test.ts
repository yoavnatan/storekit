/**
 * robots.txt is HOST-DEPENDENT, and for as long as it was a static file it could not be.
 *
 * A seller's verified domain serves their store, and `sitemap-content.xml` already answers that
 * domain with that domain's own sitemap. The static `public/robots.txt` answered it with the
 * platform's — two `Sitemap:` lines pointing at `dezabin.co.il` from a host that is not
 * `dezabin.co.il`. A cross-host sitemap reference is ignored by every engine (neither host has
 * proven it owns the other), so the seller's domain declared no sitemap at all while its real one
 * sat there unannounced. The file whose entire job is to tell a crawler where to look was the one
 * file that could not tell hosts apart.
 *
 * The other half is the feed. Merchant Center and the Meta catalog fetch it from the PLATFORM
 * domain and only from there (custom-domain.ts#AD_LANDING_PARAM) — so `/api/feed/` must stay
 * crawlable on the platform host and must NOT be re-invited on a seller's, which would publish the
 * whole mall's catalogue under their hostname.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const byCustomDomain = vi.hoisted(() => vi.fn());
// Spread the real module: `custom-domain.ts` imports `isReservedSlug` from it, so a mock that
// replaces the whole module breaks the import chain of the file under test.
vi.mock('../src/lib/stores.js', async (actual) => ({
  ...(await actual<typeof import('../src/lib/stores.js')>()),
  getStoreByCustomDomain: byCustomDomain,
}));

import { GET, AI_AGENTS } from '../src/pages/robots.txt.js';
import { store as platform } from '../src/config/store.config.js';

async function robotsFor(host: string): Promise<string> {
  const ctx = { request: new Request('https://x/robots.txt', { headers: { host } }) };
  return (await GET(ctx as never)).text();
}

const SELLER_STORE = { slug: 'acme', customDomain: { hostname: 'shop.acme.co.il', status: 'active' } };

describe('robots.txt on the platform host', () => {
  beforeEach(() => { byCustomDomain.mockReset(); });

  it('declares the platform sitemaps and no other host', async () => {
    const body = await robotsFor(new URL(platform.url).hostname);
    expect(body).toContain(`Sitemap: ${platform.url.replace(/\/+$/, '')}/sitemap-index.xml`);
    expect(body).toContain(`Sitemap: ${platform.url.replace(/\/+$/, '')}/sitemap-content.xml`);
  });

  it('keeps the product feed crawlable — Merchant Center honours robots.txt', async () => {
    const body = await robotsFor(new URL(platform.url).hostname);
    // Google resolves the LONGEST matching rule, so the Allow has to outlive the Disallow below it.
    expect(body).toContain('Allow: /api/feed/');
    expect(body).toContain('Disallow: /api');
    expect(body.indexOf('Allow: /api/feed/')).toBeLessThan(body.indexOf('Disallow: /api\n'));
  });

  it('never asks the database about a host that cannot be a custom domain', async () => {
    await robotsFor(new URL(platform.url).hostname);
    expect(byCustomDomain).not.toHaveBeenCalled();
  });

  it('keeps the private surfaces out', async () => {
    const body = await robotsFor(new URL(platform.url).hostname);
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /checkout');
  });
});

describe("robots.txt on a seller's own domain", () => {
  beforeEach(() => { byCustomDomain.mockReset(); byCustomDomain.mockResolvedValue(SELLER_STORE); });

  it('declares THAT host\'s sitemap and never the platform\'s', async () => {
    const body = await robotsFor('shop.acme.co.il');
    expect(body).toContain('Sitemap: https://shop.acme.co.il/sitemap-content.xml');
    expect(body).not.toContain('dezabin.co.il');
  });

  it('does not re-invite crawlers into the platform feed under the seller\'s hostname', async () => {
    const body = await robotsFor('shop.acme.co.il');
    expect(body).not.toContain('Allow: /api/feed/');
    expect(body).toContain('Disallow: /api');
  });

  it('still blocks the platform routes that really do resolve there', async () => {
    // The middleware passes reserved routes through untouched, so /checkout and /admin genuinely
    // render on a custom host. They must stay out of the index there too.
    const body = await robotsFor('shop.acme.co.il');
    expect(body).toContain('Disallow: /admin');
    expect(body).toContain('Disallow: /checkout');
  });

  it('states the crawl rules but declares NO sitemap on a host no store claims', async () => {
    // Changed 2026-08-21, area audit of the SEO surfaces. This used to fall through to the
    // platform's two `Sitemap:` lines, which is the very cross-host reference the whole file exists
    // to stop — an old domain still 301-ing, or DNS pointed here before its store connected, was
    // being told that `dezabin.co.il`'s sitemap is this host's sitemap. An engine ignores it and
    // Search Console reports it against whoever owns that hostname. The RULES still fall through:
    // they describe paths, and they are never wrong to state.
    byCustomDomain.mockResolvedValue(null);
    const body = await robotsFor('someone-elses.example');
    expect(body).toContain('Disallow: /admin');
    expect(body).not.toContain('Sitemap:');
    expect(body).not.toContain('dezabin.co.il');
  });

  it('declares no sitemap when the database could not say whose host this is', async () => {
    // The failure direction that matters: silence about a sitemap costs a crawl of one host until
    // the next fetch; naming the wrong one is a claim about a domain we do not own.
    byCustomDomain.mockRejectedValue(new Error('DATABASE_URL is not set'));
    const body = await robotsFor('shop.acme.co.il');
    expect(body).not.toContain('Sitemap:');
  });

  it('still answers 200 when the database is unreachable', async () => {
    // Google reads a 5xx on robots.txt as "disallow everything" and pauses crawling the whole site
    // for hours. A database outage must not become an SEO outage that outlives it — this file has
    // no content worth failing over. Found by serving a real build with no DATABASE_URL.
    byCustomDomain.mockRejectedValue(new Error('DATABASE_URL is not set'));
    const ctx = { request: new Request('https://x/robots.txt', { headers: { host: 'shop.acme.co.il' } }) };
    const res = await GET(ctx as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Allow: /');
  });
});

describe('the AI crawler invitation', () => {
  beforeEach(() => { byCustomDomain.mockReset(); });

  it('repeats the protections inside the named group — a named group REPLACES the * rules', async () => {
    const body = await robotsFor(new URL(platform.url).hostname);
    const named = body.slice(body.indexOf(`User-agent: ${AI_AGENTS[0]}`));
    expect(named).toContain('Disallow: /admin');
    expect(named).toContain('Disallow: /checkout');
    expect(named).toContain('Disallow: /api');
  });

  it('names every engine we mean to welcome', async () => {
    const body = await robotsFor(new URL(platform.url).hostname);
    for (const agent of AI_AGENTS) expect(body).toContain(`User-agent: ${agent}`);
  });
});
