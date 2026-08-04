/**
 * First-party ad attribution — `src/lib/attribution.ts` (GO_LIVE_CHECKLIST.md §2.5, layer 5).
 *
 * What makes this worth testing rather than reading: every value here is attacker-controlled on
 * BOTH ends. The query string is a URL anyone can craft, and the cookie is client state that
 * `httpOnly` protects from our own scripts and from nobody else. A record that survives this module
 * is stamped on an order and will one day decide which campaign gets credited with a sale — and a
 * campaign's spend is billed to a seller, so a forged attribution is a money question, not a
 * reporting one.
 *
 * The four properties that would not fail a naive implementation:
 *   · a landing with NO parameters leaves an earlier click's cookie alone — the whole lookback
 *     window is built on the buyer who leaves and comes back through the front door;
 *   · last click REPLACES, never merges — a merged record credits two networks with one sale,
 *     which is the exact double-count §2.5 exists to prevent;
 *   · the window is enforced on the way IN (may this click still claim a purchase?) and NOT on the
 *     way out of storage (an order placed a year ago keeps reading back the same);
 *   · a forged future timestamp does not buy an immortal attribution.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_WINDOW_DAYS,
  captureAttribution,
  decodeAttribution,
  encodeAttribution,
  parseLandingAttribution,
  readAttribution,
  sanitizeAttribution,
  type OrderAttribution,
} from '../src/lib/attribution.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-04T12:00:00.000Z');

/** The slice of `AstroCookies` this module touches, with the same get/set semantics. */
function fakeCookies(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  const options: Record<string, unknown> = {};
  return {
    jar,
    options,
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts: Record<string, unknown>) => {
      jar.set(name, value);
      Object.assign(options, opts);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stand-in for the three methods used.
  } as any;
}

const landing = (search: string) => new URL(`https://dezabin.com/some-store${search}`);

describe('parseLandingAttribution', () => {
  it('reads every click id and UTM tag off the landing URL', () => {
    const rec = parseLandingAttribution(
      landing('?gclid=abc123&utm_source=google&utm_medium=cpc&utm_campaign=summer&utm_content=v2&utm_term=shoes'),
      NOW,
    );
    expect(rec).toEqual({
      gclid: 'abc123',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'summer',
      utmContent: 'v2',
      utmTerm: 'shoes',
      landedAt: new Date(NOW).toISOString(),
    });
  });

  it('reads Meta and the two iOS Google click ids', () => {
    expect(parseLandingAttribution(landing('?fbclid=fb.1.abc'), NOW)?.fbclid).toBe('fb.1.abc');
    // gbraid/wbraid replace gclid on iOS when ATT consent is absent. Missing them does not look
    // like a measurement gap, it looks like the mobile half of the campaign did not convert.
    expect(parseLandingAttribution(landing('?gbraid=G1'), NOW)?.gbraid).toBe('G1');
    expect(parseLandingAttribution(landing('?wbraid=W1'), NOW)?.wbraid).toBe('W1');
  });

  it('is null when the URL carries nothing relevant — the case that must not clear a cookie', () => {
    expect(parseLandingAttribution(landing(''), NOW)).toBeNull();
    expect(parseLandingAttribution(landing('?page=2&category=shirts&q=blue'), NOW)).toBeNull();
  });

  it('ignores an empty parameter rather than storing a blank campaign', () => {
    expect(parseLandingAttribution(landing('?gclid=&utm_source=%20'), NOW)).toBeNull();
    expect(parseLandingAttribution(landing('?gclid=&utm_source=google'), NOW))
      .toEqual({ utmSource: 'google', landedAt: new Date(NOW).toISOString() });
  });

  it('drops an over-length value but keeps the rest of the landing', () => {
    const huge = 'x'.repeat(200);
    const rec = parseLandingAttribution(landing(`?gclid=${huge}&utm_source=google`), NOW);
    expect(rec).toEqual({ utmSource: 'google', landedAt: new Date(NOW).toISOString() });
  });

  it('strips control characters instead of losing a real click over a pasted newline', () => {
    const rec = parseLandingAttribution(landing('?utm_campaign=summer%0A%09sale'), NOW);
    expect(rec?.utmCampaign).toBe('summersale');
  });

  it('keeps a Hebrew campaign name intact', () => {
    const rec = parseLandingAttribution(landing(`?utm_campaign=${encodeURIComponent('קיץ 2026')}`), NOW);
    expect(rec?.utmCampaign).toBe('קיץ 2026');
  });
});

describe('cookie round trip', () => {
  it('survives encode → decode unchanged, Hebrew included', () => {
    const rec: OrderAttribution = {
      gclid: 'abc123',
      utmSource: 'google',
      utmCampaign: 'קיץ 2026',
      landedAt: new Date(NOW).toISOString(),
    };
    expect(decodeAttribution(encodeAttribution(rec), NOW)).toEqual(rec);
  });

  it('refuses every malformed cookie without throwing — this runs inside checkout', () => {
    for (const bad of ['', 'not-base64!!!', Buffer.from('not json').toString('base64url'),
      Buffer.from('[]').toString('base64url'), Buffer.from('null').toString('base64url'),
      Buffer.from('"a string"').toString('base64url'), Buffer.from('{}').toString('base64url')]) {
      expect(decodeAttribution(bad, NOW)).toBeNull();
    }
    expect(decodeAttribution(undefined, NOW)).toBeNull();
  });

  it('refuses a record whose landedAt is missing or unparseable', () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    expect(decodeAttribution(enc({ gclid: 'a' }), NOW)).toBeNull();
    expect(decodeAttribution(enc({ gclid: 'a', landedAt: 'yesterday' }), NOW)).toBeNull();
    expect(decodeAttribution(enc({ gclid: 'a', landedAt: 12345 }), NOW)).toBeNull();
  });

  it('refuses a record that carries a timestamp and nothing else', () => {
    // "No attribution" and "an attribution with no fields" must not be two states downstream.
    const enc = Buffer.from(JSON.stringify({ landedAt: new Date(NOW).toISOString() }), 'utf8').toString('base64url');
    expect(decodeAttribution(enc, NOW)).toBeNull();
  });

  it('re-cleans the values on the way out — a hand-written cookie gets no free pass', () => {
    const enc = Buffer.from(JSON.stringify({
      gclid: 'x'.repeat(500),
      utmSource: { nested: 'object' },
      utmCampaign: 'google',
      landedAt: new Date(NOW).toISOString(),
    }), 'utf8').toString('base64url');
    expect(decodeAttribution(enc, NOW)).toEqual({ utmCampaign: 'google', landedAt: new Date(NOW).toISOString() });
  });
});

describe('the lookback window', () => {
  const rec = (landedAt: number): string =>
    encodeAttribution({ gclid: 'abc', landedAt: new Date(landedAt).toISOString() });

  it('accepts a click from inside the window', () => {
    expect(decodeAttribution(rec(NOW - 29 * DAY), NOW)).not.toBeNull();
  });

  it('refuses a click older than the window', () => {
    expect(decodeAttribution(rec(NOW - (ATTRIBUTION_WINDOW_DAYS + 1) * DAY), NOW)).toBeNull();
  });

  it('refuses a forged future timestamp, which would otherwise never expire', () => {
    expect(decodeAttribution(rec(NOW + 90 * DAY), NOW)).toBeNull();
  });

  it('tolerates small clock skew', () => {
    expect(decodeAttribution(rec(NOW + 60_000), NOW)).not.toBeNull();
  });

  it('is NOT applied to a record read back out of storage', () => {
    // An order placed two years ago still carries the click that produced it. Applying the window
    // here would quietly empty the attribution of every order older than a month — the report this
    // whole feature exists for, deleted by its own validator.
    const old = { gclid: 'abc', landedAt: new Date(NOW - 700 * DAY).toISOString() };
    expect(sanitizeAttribution(old)).toEqual(old);
  });
});

describe('captureAttribution', () => {
  it('writes an httpOnly, lax, window-length cookie', () => {
    const cookies = fakeCookies();
    captureAttribution(landing('?gclid=abc'), cookies, NOW);
    expect(decodeAttribution(cookies.jar.get(ATTRIBUTION_COOKIE), NOW)?.gclid).toBe('abc');
    expect(cookies.options).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax' });
    // `lax` and not `strict`: the visitor arrives by a top-level navigation from google.com, and
    // `strict` would withhold the cookie on exactly that request.
    expect(cookies.options['maxAge']).toBe(ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60);
  });

  it('leaves an existing cookie ALONE when the landing carries no parameters', () => {
    // The buyer who clicks the ad, leaves, and comes back days later through the front door is the
    // exact case the window exists to measure. Clearing here would delete it.
    const first = encodeAttribution({ gclid: 'abc', landedAt: new Date(NOW - 3 * DAY).toISOString() });
    const cookies = fakeCookies({ [ATTRIBUTION_COOKIE]: first });
    captureAttribution(landing('/?page=2'), cookies, NOW);
    expect(cookies.jar.get(ATTRIBUTION_COOKIE)).toBe(first);
    expect(readAttribution(cookies, NOW)?.gclid).toBe('abc');
  });

  it('REPLACES the previous record whole — last click wins, nothing is merged', () => {
    const cookies = fakeCookies();
    captureAttribution(landing('?gclid=google-click&utm_campaign=summer'), cookies, NOW - 2 * DAY);
    captureAttribution(landing('?fbclid=meta-click'), cookies, NOW);
    // A merge would leave gclid AND fbclid on one order — Google and Meta each credited with the
    // same sale, in our own database. That is the double-count §2.5 layer 5 exists to remove.
    expect(readAttribution(cookies, NOW)).toEqual({
      fbclid: 'meta-click',
      landedAt: new Date(NOW).toISOString(),
    });
  });

  it('restarts the window on the newer click', () => {
    const cookies = fakeCookies();
    captureAttribution(landing('?gclid=old'), cookies, NOW - 29 * DAY);
    captureAttribution(landing('?gclid=new'), cookies, NOW);
    expect(readAttribution(cookies, NOW + 20 * DAY)?.gclid).toBe('new');
  });

  it('drops a crafted landing whole rather than storing a truncated click id', () => {
    const cookies = fakeCookies();
    // Every field at the per-value maximum still clears the cookie budget; the refusal is for a URL
    // built to blow past it, and half a click id joins to nothing while looking real.
    const params = new URLSearchParams();
    for (const p of ['gclid', 'gbraid', 'wbraid', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      params.set(p, 'א'.repeat(128)); // 128 chars, but 3 bytes each once encoded
    }
    expect(captureAttribution(landing(`?${params}`), cookies, NOW)).toBeNull();
    expect(cookies.jar.has(ATTRIBUTION_COOKIE)).toBe(false);
  });

  it('a full set of realistically-sized parameters is stored, not refused', () => {
    const cookies = fakeCookies();
    const params = new URLSearchParams({
      gclid: 'Cj0KCQjw' + 'x'.repeat(80),
      fbclid: 'IwAR' + 'y'.repeat(90),
      utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'summer-sale-2026',
      utm_content: 'carousel-b', utm_term: 'נעלי ריצה',
    });
    expect(captureAttribution(landing(`?${params}`), cookies, NOW)).not.toBeNull();
    expect(readAttribution(cookies, NOW)?.utmTerm).toBe('נעלי ריצה');
  });
});

describe('readAttribution', () => {
  it('is null with no cookie at all — the organic purchase, which is most of them', () => {
    expect(readAttribution(fakeCookies(), NOW)).toBeNull();
  });
});
