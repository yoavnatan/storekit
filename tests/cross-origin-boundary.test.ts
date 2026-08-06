/**
 * The custom-domain → platform boundary.
 *
 * A verified custom domain is a different browser ORIGIN, and that is not a routing detail: the
 * cart is `localStorage` and the session is a host-scoped cookie, so a shopper crossing from
 * `shop.acme.co.il` to `dezabin.co.il` arrives — by default — logged out, with an empty basket and
 * with the ad click that paid for them forgotten. The decision (2026-08-06) is that the store is
 * sovereign for BROWSING and the platform owns the TRANSACTION, which makes the crossing a thing
 * the application performs on purpose rather than something that happens to it.
 *
 * Three mechanisms, pinned here because each one fails silently and none of them shows up on a
 * screen: which paths belong to the platform, what may cross, and what a crafted URL may not do.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { isPlatformOwnedPath, PLATFORM_PAGE_SEGMENTS, HOST_LOCAL_SEGMENTS, HANDOFF_PARAM } from '../src/lib/platform-routes.js';
import { signHandoff, readHandoff, HANDOFF_TTL_MS, platformPageUrl } from '../src/lib/cross-origin-handoff.js';
import { encodeHandoffCart, decodeHandoffCart, CART_FRAGMENT_KEY } from '../src/lib/cart-handoff.js';
import { RESERVED_SLUGS } from '../src/lib/stores.js';

// ── 1. Which paths belong to the platform ────────────────────────────────────

describe('isPlatformOwnedPath', () => {
  it('claims the transaction and the account', () => {
    for (const p of ['/checkout', '/cart', '/account', '/buyer/dashboard', '/seller/dashboard', '/admin', '/stores', '/search', '/terms', '/contact']) {
      expect(isPlatformOwnedPath(p), p).toBe(true);
    }
  });

  it('strips the query before reading the segment', () => {
    // The cart drawer writes `/checkout?store=acme`. Reading that whole string as the segment
    // matched nothing, which would have left the single most important link on the boundary behind.
    expect(isPlatformOwnedPath('/checkout?store=acme')).toBe(true);
    expect(isPlatformOwnedPath('/checkout#c=abc')).toBe(true);
  });

  it('never claims the store itself', () => {
    // The two paths a custom domain exists to serve. A false positive here would 302 a seller's own
    // storefront off their own domain.
    for (const p of ['/', '/blue-widget', '/נעל-ריצה', '/some-store/some-product', '']) {
      expect(isPlatformOwnedPath(p), p).toBe(false);
    }
  });

  it('leaves the serving host its own machinery', () => {
    // Redirecting these breaks the page that is being rendered: its own fetches turn into CORS
    // failures, and a crawler on the seller's domain gets sent to the platform's robots.txt — the
    // exact bug src/pages/robots.txt.ts was rewritten to fix.
    for (const seg of HOST_LOCAL_SEGMENTS) {
      expect(isPlatformOwnedPath(`/${seg}`), seg).toBe(false);
    }
    expect(isPlatformOwnedPath('/api/store-product')).toBe(false);
  });

  it('every segment it names is a reserved slug — a seller could otherwise own one', () => {
    // If `checkout` were registrable, a store could claim it and the boundary would start
    // redirecting that store's own home page to the platform.
    const takeable = PLATFORM_PAGE_SEGMENTS.filter((s) => !RESERVED_SLUGS.has(s));
    expect(takeable, 'add these to RESERVED_SLUGS in stores.ts').toEqual([]);
  });

  it('the two lists together account for every reserved slug', () => {
    // The drift this refuses: a new top-level page route is added to RESERVED_SLUGS and nobody
    // decides which side of the boundary it is on, so it silently stays on the seller's domain.
    const covered = new Set([...PLATFORM_PAGE_SEGMENTS, ...HOST_LOCAL_SEGMENTS]);
    const undecided = [...RESERVED_SLUGS].filter((s) => !covered.has(s));
    expect(undecided, 'decide: platform-owned page, or served by whichever host answers?').toEqual([]);
  });
});

// ── 2. The signed identity carry-over ────────────────────────────────────────

const VID = 'a1b2c3d4e5f60718293a';

describe('the handoff token', () => {
  beforeEach(() => { vi.stubEnv('AUTH_SECRET', 'test-secret-for-handoff'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('round-trips a visitor id and an attribution record', () => {
    const token = signHandoff({ vid: VID, attr: 'eyJhIjoxfQ' });
    expect(readHandoff(token)).toMatchObject({ vid: VID, attr: 'eyJhIjoxfQ' });
  });

  it('mints nothing when there is nothing to carry', () => {
    // The common case: an anonymous shopper with no ad click. A signature of nothing is noise in
    // the address bar and a link that looks like it carries a secret when it carries none.
    expect(signHandoff({})).toBe('');
    expect(signHandoff({ vid: 'not-a-visitor-id' })).toBe('');
  });

  it('REFUSES a payload it did not sign — an ad click is a number the platform bills against', () => {
    // Without the signature anyone could hand themselves a gclid and write it onto a real order,
    // crediting a campaign with a sale it did not produce.
    const forged = Buffer.from(JSON.stringify({ vid: VID, exp: Date.now() + 60_000 }), 'utf8').toString('base64url');
    expect(readHandoff(`${forged}.not-a-real-signature`)).toBeNull();
    expect(readHandoff(forged)).toBeNull();
    expect(readHandoff('')).toBeNull();
    expect(readHandoff('....')).toBeNull();
  });

  it('refuses a token signed with a different secret', () => {
    const token = signHandoff({ vid: VID });
    vi.stubEnv('AUTH_SECRET', 'a-completely-different-secret');
    expect(readHandoff(token)).toBeNull();
  });

  it('expires — it rides in a URL, so it can be copied out of an address bar', () => {
    const now = 1_000_000;
    const token = signHandoff({ vid: VID }, now);
    expect(readHandoff(token, now + HANDOFF_TTL_MS - 1)).not.toBeNull();
    expect(readHandoff(token, now + HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it('re-validates the SHAPE on the way out, not just the signature', () => {
    // A signature proves who wrote a value, never that the value is well-formed — and this one is
    // about to be written into a cookie that every unique-visitor figure is keyed on.
    const body = Buffer.from(JSON.stringify({ vid: 'ZZZ', exp: Date.now() + 60_000 }), 'utf8').toString('base64url');
    const legitimatelySigned = signHandoff({ vid: VID });
    const mac = legitimatelySigned.slice(legitimatelySigned.indexOf('.') + 1);
    expect(readHandoff(`${body}.${mac}`)).toBeNull();  // wrong mac for this body anyway
    expect(readHandoff(`${body}.`)).toBeNull();
  });

  it('names the parameter the browser also has to know', () => {
    expect(HANDOFF_PARAM).toBe('h');
  });
});

describe('platformPageUrl — where a platform page requested on a seller domain goes', () => {
  it('lands on the platform, path and query intact', () => {
    expect(platformPageUrl('/checkout', '?store=acme'))
      .toBe('https://dezabin.co.il/checkout?store=acme');
    expect(platformPageUrl('/buyer/dashboard')).toBe('https://dezabin.co.il/buyer/dashboard');
  });

  it('encodes a Hebrew query, because /search is platform-owned and this catalogue is Hebrew', () => {
    // NOT theoretical: a shopper on a seller's domain searching the mall. A raw Hebrew byte in a
    // Location header THROWS — they would have received a 500 instead of a redirect.
    const url = platformPageUrl('/search', '?q=נעליים');
    expect(url).toBe('https://dezabin.co.il/search?q=%D7%A0%D7%A2%D7%9C%D7%99%D7%99%D7%9D');
    expect(() => new Response(null, { status: 302, headers: { Location: url } })).not.toThrow();
  });
});

// ── 3. The cart that travels in the fragment ─────────────────────────────────

const CART = {
  storeSlug: 'acme',
  storeName: 'אקמה',
  items: [{ cartKey: 'blue', slug: 'blue', name: 'כחול', price: 49.9, image: '/i.jpg', qty: 2 }],
};

describe('the handed-over cart', () => {
  it('round-trips, Hebrew included', () => {
    const back = decodeHandoffCart(encodeHandoffCart(CART));
    expect(back?.storeName).toBe('אקמה');
    expect(back?.items[0]).toMatchObject({ slug: 'blue', name: 'כחול', qty: 2, price: 49.9 });
  });

  it('produces a value that survives a URL', () => {
    // base64url: the whole reason it is not raw JSON. A `+`, a `/` or a `=` in a fragment is a
    // different string by the time it has been through an address bar and a chat app.
    expect(encodeHandoffCart(CART)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(CART_FRAGMENT_KEY).toBe('c');
  });

  it('never throws on a fragment somebody typed', () => {
    // A malformed fragment must leave the shopper on a working checkout with the cart they already
    // had — not on an error page, at the slowest moment in the funnel.
    for (const junk of ['', null, undefined, 'not-base64!!', 'e30', btoa('[]'), btoa('null'), btoa('{"storeSlug":"a"}')]) {
      expect(() => decodeHandoffCart(junk as string)).not.toThrow();
      expect(decodeHandoffCart(junk as string)).toBeNull();
    }
  });

  it('drops lines that are not lines, and keeps the rest', () => {
    const mixed = encodeHandoffCart({
      ...CART,
      items: [
        CART.items[0]!,
        { cartKey: 'x', slug: 'x', name: 'no qty', price: 5, image: '', qty: 0 },
        { cartKey: 'y', slug: 'y', name: 'negative', price: -1, image: '', qty: 1 },
        null as never,
      ],
    });
    const back = decodeHandoffCart(mixed);
    expect(back?.items.map((i) => i.slug)).toEqual(['blue']);
  });

  it('refuses control characters — these land in textContent and in data- attributes', () => {
    expect(decodeHandoffCart(encodeHandoffCart({ ...CART, storeName: 'a b' }))).toBeNull();
    const back = decodeHandoffCart(encodeHandoffCart({
      ...CART, items: [{ ...CART.items[0]!, name: 'line\nbreak' }],
    }));
    expect(back).toBeNull();
  });

  it('bounds the basket', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...CART.items[0]!, cartKey: `k${i}`, slug: `s${i}` }));
    expect(decodeHandoffCart(encodeHandoffCart({ ...CART, items: many }))!.items.length).toBe(60);
    expect(decodeHandoffCart(encodeHandoffCart({
      ...CART, items: [{ ...CART.items[0]!, qty: 10_000 }],
    }))).toBeNull();
  });

  it('carries no authority: a crafted cart can only fill its own author\'s basket', () => {
    // Prices here are display-only in exactly the sense cart.ts already documents — /api/checkout
    // re-resolves every line from storeSlug + slug server-side. This test pins the READING half:
    // whatever arrives is a plain, bounded record with no field that grants anything.
    const back = decodeHandoffCart(encodeHandoffCart({
      ...CART,
      items: [{ ...CART.items[0]!, price: 0.01 }],
    }));
    expect(Object.keys(back!)).toEqual(['storeSlug', 'storeName', 'items']);
    expect(back!.items[0]!.price).toBeCloseTo(0.01, 5);  // preserved for DISPLAY, never for charging
  });
});
