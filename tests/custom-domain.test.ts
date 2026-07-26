import { describe, it, expect } from 'vitest';
import { normalizeHostname, resolveCustomDomainRewrite, storeCanonicalUrl, productCanonicalUrl, storeHomeHref, isPlatformHost, isUnclaimedCustomHost, customDomainRedirectUrl } from '../src/lib/custom-domain.js';

// Platform host is store.config.ts → 'https://dezabin.com'.
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
    expect(normalizeHostname('dezabin.com')).toBeNull();
    expect(normalizeHostname('www.dezabin.com')).toBeNull();
    expect(normalizeHostname('evil.dezabin.com')).toBeNull();
    expect(normalizeHostname('https://dezabin.com/store/x')).toBeNull();
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
    expect(storeCanonicalUrl(noDomain)).toBe('https://dezabin.com/acme');
    expect(storeCanonicalUrl(pending)).toBe('https://dezabin.com/acme'); // pending is NOT canonical
    expect(storeCanonicalUrl(active)).toBe('https://shop.acme.co.il');
  });

  it('product: platform path unless a domain is active (served from root on the custom domain)', () => {
    expect(productCanonicalUrl(noDomain, 'blue-widget')).toBe('https://dezabin.com/acme/blue-widget');
    expect(productCanonicalUrl(active, 'blue-widget')).toBe('https://shop.acme.co.il/blue-widget');
  });

  it('storeHomeHref: platform surfaces link to the seller domain (external) when active, else internal', () => {
    expect(storeHomeHref(noDomain)).toBe('/acme');
    expect(storeHomeHref(pending)).toBe('/acme'); // pending → still internal
    expect(storeHomeHref(active)).toBe('https://shop.acme.co.il');
  });

  it('customDomainRedirectUrl: 301 the platform path to the seller domain, but never loop on it', () => {
    // On the platform host → redirect out to the custom domain (SEO consolidates there).
    expect(customDomainRedirectUrl(active, 'dezabin.com', '')).toBe('https://shop.acme.co.il');
    expect(customDomainRedirectUrl(active, 'dezabin.com', '?sort=price')).toBe('https://shop.acme.co.il?sort=price');
    expect(customDomainRedirectUrl(active, 'localhost:4321', '/blue-widget')).toBe('https://shop.acme.co.il/blue-widget');
    // Already ON the custom domain (middleware rewrote onto this route) → no redirect (no loop).
    expect(customDomainRedirectUrl(active, 'shop.acme.co.il', '')).toBeNull();
    expect(customDomainRedirectUrl(active, 'shop.acme.co.il:443', '')).toBeNull();
    // No active domain → never redirect.
    expect(customDomainRedirectUrl(noDomain, 'dezabin.com', '')).toBeNull();
    expect(customDomainRedirectUrl(pending, 'dezabin.com', '')).toBeNull();
  });
});

describe('host classification (routing safety)', () => {
  it('isPlatformHost: our own hosts + loopback served normally; foreign domains are not', () => {
    for (const h of ['dezabin.com', 'www.dezabin.com', 'dezabin.com:443', 'localhost', 'localhost:4321', '127.0.0.1', '::1']) {
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
    for (const h of ['dezabin.com', 'www.dezabin.com', 'localhost', '127.0.0.1', '10.0.0.5', '192.168.1.20', 'origin-internal', 'demo.localhost', '']) {
      expect(isUnclaimedCustomHost(h, false)).toBe(false);
    }
  });
});
