import { describe, it, expect, vi } from 'vitest';
import { normalizeHostname, resolveCustomDomainRewrite, storeCanonicalUrl, productCanonicalUrl, storeHomeHref, previousDomainRedirectUrl, isPlatformHost, isUnclaimedCustomHost, customDomainRedirectUrl, hostnameAlias } from '../src/lib/custom-domain.js';

// Platform host is store.config.ts → 'https://dezabin.co.il'.
describe('normalizeHostname', () => {
  it('accepts a valid external hostname and lowercases it', () => {
    expect(normalizeHostname('Shop.MyBrand.co.il')).toBe('shop.mybrand.co.il');
  });

  it('strips scheme, path and port', () => {
    expect(normalizeHostname('https://shop.example.com:8443/path?x=1')).toBe('shop.example.com');
  });

  it('rejects malformed hostnames', () => {
    for (const bad of ['', '   ', 'nodot', 'has space.com', '-lead.com', 'trail-.com', 'a..b.com']) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });

  it('SECURITY: refuses to claim the platform domain or any subdomain of it', () => {
    expect(normalizeHostname('dezabin.co.il')).toBeNull();
    expect(normalizeHostname('www.dezabin.co.il')).toBeNull();
    expect(normalizeHostname('evil.dezabin.co.il')).toBeNull();
    expect(normalizeHostname('https://dezabin.co.il/store/x')).toBeNull();
  });

  it('SECURITY: refuses any host PLATFORM_HOSTS declares as ours', () => {
    // The routing side has always refused to read these as a store (`isPlatformHost`); the claiming
    // side did not, so the record and the router disagreed — the seller's dashboard would say
    // "connected" and wait forever for a verification that cannot arrive. GO_LIVE §1 puts the
    // Cloudflare fallback origin in here, which is the one that used to matter most.
    vi.stubEnv('PLATFORM_HOSTS', 'staging.example.net, origin.dezabin-cdn.net');
    expect(normalizeHostname('staging.example.net')).toBeNull();
    expect(normalizeHostname('ORIGIN.dezabin-cdn.net')).toBeNull();
    // Everything else still passes — the rule is "ours", not "anything that looks internal".
    expect(normalizeHostname('shop.mybrand.co.il')).toBe('shop.mybrand.co.il');
    vi.unstubAllEnvs();
  });
});

describe('resolveCustomDomainRewrite', () => {
  it('maps the root to the store home (root-level store URL)', () => {
    expect(resolveCustomDomainRewrite('acme', '/')).toBe('/acme');
    expect(resolveCustomDomainRewrite('acme', '')).toBe('/acme');
  });

  it('maps a single segment to a pretty product URL', () => {
    expect(resolveCustomDomainRewrite('acme', '/blue-widget')).toBe('/acme/blue-widget');
    expect(resolveCustomDomainRewrite('acme', '/blue-widget/')).toBe('/acme/blue-widget');
  });

  it('passes assets and .txt/.xml segments through (null)', () => {
    expect(resolveCustomDomainRewrite('acme', '/style.css')).toBeNull();
    expect(resolveCustomDomainRewrite('acme', '/robots.txt')).toBeNull();
  });

  it('passes the store\'s own slug through (rewrite re-entry guard — prevents a loop)', () => {
    expect(resolveCustomDomainRewrite('acme', '/acme')).toBeNull();
    expect(resolveCustomDomainRewrite('acme', '/acme/')).toBeNull();
  });

  it('passes real top-level routes and deep paths through (null)', () => {
    for (const p of ['/api', '/checkout', '/admin', '/store', '/stores', '/search',
                     '/store/acme', '/store/acme/x', '/api/store-products']) {
      expect(resolveCustomDomainRewrite('acme', p)).toBeNull();
    }
  });
});

describe('canonical URLs (SEO credit follows an active custom domain)', () => {
  const noDomain = { slug: 'acme' };
  const pending = { slug: 'acme', customDomain: { hostname: 'shop.acme.co.il', status: 'pending' as const, addedAt: '' } };
  const active = { slug: 'acme', customDomain: { hostname: 'shop.acme.co.il', status: 'active' as const, addedAt: '' } };

  it('store home: platform path unless a domain is active', () => {
    expect(storeCanonicalUrl(noDomain)).toBe('https://dezabin.co.il/acme');
    expect(storeCanonicalUrl(pending)).toBe('https://dezabin.co.il/acme'); // pending is NOT canonical
    expect(storeCanonicalUrl(active)).toBe('https://shop.acme.co.il');
  });

  it('product: platform path unless a domain is active (served from root on the custom domain)', () => {
    expect(productCanonicalUrl(noDomain, 'blue-widget')).toBe('https://dezabin.co.il/acme/blue-widget');
    expect(productCanonicalUrl(active, 'blue-widget')).toBe('https://shop.acme.co.il/blue-widget');
  });

  it('storeHomeHref: platform surfaces link to the seller domain (external) when active, else internal', () => {
    expect(storeHomeHref(noDomain)).toBe('/acme');
    expect(storeHomeHref(pending)).toBe('/acme'); // pending → still internal
    expect(storeHomeHref(active)).toBe('https://shop.acme.co.il');
  });

  it('customDomainRedirectUrl: 301 the platform path to the seller domain, but never loop on it', () => {
    // On the platform host → redirect out to the custom domain (SEO consolidates there).
    expect(customDomainRedirectUrl(active, 'dezabin.co.il', '')).toBe('https://shop.acme.co.il');
    expect(customDomainRedirectUrl(active, 'dezabin.co.il', '?sort=price')).toBe('https://shop.acme.co.il?sort=price');
    expect(customDomainRedirectUrl(active, 'localhost:4321', '/blue-widget')).toBe('https://shop.acme.co.il/blue-widget');
    // Already ON the custom domain (middleware rewrote onto this route) → no redirect (no loop).
    expect(customDomainRedirectUrl(active, 'shop.acme.co.il', '')).toBeNull();
    expect(customDomainRedirectUrl(active, 'shop.acme.co.il:443', '')).toBeNull();
    // No active domain → never redirect.
    expect(customDomainRedirectUrl(noDomain, 'dezabin.co.il', '')).toBeNull();
    expect(customDomainRedirectUrl(pending, 'dezabin.co.il', '')).toBeNull();
  });
});

describe('an old domain the store has left', () => {
  // The case the seller actually hits: they connected shop.acme.co.il, Google consolidated the
  // store's whole ranking onto it (that is what the 301 above is FOR), and then they removed it or
  // swapped it for another. Every link, bookmark and indexed page on the old host used to 404.
  const backOnPlatform = { slug: 'acme' };
  const movedAgain = { slug: 'acme', customDomain: { hostname: 'new.acme.co.il', status: 'active' as const, addedAt: '' } };

  it('sends the root of the old domain to the store home, wherever that is now', () => {
    expect(previousDomainRedirectUrl(backOnPlatform, '/')).toBe('https://dezabin.co.il/acme');
    expect(previousDomainRedirectUrl(movedAgain, '/')).toBe('https://new.acme.co.il');
  });

  it('carries the path over — the store was at the ROOT of the old domain', () => {
    expect(previousDomainRedirectUrl(backOnPlatform, '/blue-widget')).toBe('https://dezabin.co.il/acme/blue-widget');
    expect(previousDomainRedirectUrl(movedAgain, '/blue-widget')).toBe('https://new.acme.co.il/blue-widget');
  });

  it('keeps the query string', () => {
    expect(previousDomainRedirectUrl(backOnPlatform, '/', '?category=נעליים'))
      .toBe('https://dezabin.co.il/acme?category=%D7%A0%D7%A2%D7%9C%D7%99%D7%99%D7%9D');
  });

  it('emits a destination that can actually be a Location header', () => {
    // A Hebrew product slug raw in a header THROWS a 500 instead of redirecting (url-base.ts).
    const target = previousDomainRedirectUrl(backOnPlatform, '/נעל-ריצה');
    expect(() => new Response(null, { status: 301, headers: { Location: target } })).not.toThrow();
  });
});

describe('host classification (routing safety)', () => {
  it('isPlatformHost: our own hosts + loopback served normally; foreign domains are not', () => {
    for (const h of ['dezabin.co.il', 'www.dezabin.co.il', 'dezabin.co.il:443', 'localhost', 'localhost:4321', '127.0.0.1', '::1']) {
      expect(isPlatformHost(h)).toBe(true);
    }
    for (const h of ['demo-shop.test', 'shop.acme.co.il', 'evil.example.com']) {
      expect(isPlatformHost(h)).toBe(false);
    }
    expect(isPlatformHost('')).toBe(true); // no Host → never a foreign domain
  });

  it('isUnclaimedCustomHost: 404 ONLY a real unclaimed external domain — never IPs, loopback, internal, or platform', () => {
    // The one case that should 404: a real external domain, not claimed by any store.
    expect(isUnclaimedCustomHost('demo-shop.test', false)).toBe(true);
    expect(isUnclaimedCustomHost('shop.acme.co.il:443', false)).toBe(true);
    // Claimed → served, never 404.
    expect(isUnclaimedCustomHost('demo-shop.test', true)).toBe(false);
    // Never 404 these (would break the platform / health checks / dev):
    for (const h of ['dezabin.co.il', 'www.dezabin.co.il', 'localhost', '127.0.0.1', '10.0.0.5', '192.168.1.20', 'origin-internal', 'demo.localhost', '']) {
      expect(isUnclaimedCustomHost(h, false)).toBe(false);
    }
  });
});

/**
 * The www/apex twin.
 *
 * A custom domain is ONE exact hostname in the record; a domain in the real world is two spellings
 * a seller points at us together, because that is what their registrar does by default. The
 * spelling that is not in the record matched no store and fell straight to the unclaimed-host 404 —
 * a dead site on the seller's own brand, on the half of it that older links and word of mouth are
 * most likely to use. The middleware now 301s the twin onto the claimed spelling
 * (middleware.ts#unclaimedHostRedirect), which also stops the two competing as duplicate content.
 */
describe('hostnameAlias', () => {
  it('adds www to a bare host and removes it from a www host', () => {
    expect(hostnameAlias('mybrand.co.il')).toBe('www.mybrand.co.il');
    expect(hostnameAlias('www.mybrand.co.il')).toBe('mybrand.co.il');
    expect(hostnameAlias('shop.mybrand.co.il')).toBe('www.shop.mybrand.co.il');
  });

  it('normalises case and port first, so a raw Host header resolves', () => {
    expect(hostnameAlias('WWW.MyBrand.co.il:443')).toBe('mybrand.co.il');
  });

  it('never proposes a single-label host — www stripped off a two-label domain is not a domain', () => {
    expect(hostnameAlias('www.localhost')).toBeNull();
    expect(hostnameAlias('nodot')).toBeNull();
    expect(hostnameAlias('')).toBeNull();
  });
});
