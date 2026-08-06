/**
 * `adoptHandoff` — what the middleware DOES with a handoff token, as opposed to whether the token
 * verifies.
 *
 * `cross-origin-boundary.test.ts` already pins the crypto: forged, wrong-secret, expired and
 * malformed tokens all read back as `null`. That is the mint-and-verify half. This file is the half
 * that runs in front of every page on the site, and its requirement is different and blunter:
 *
 *   · a token we cannot read must leave the shopper as a NEW visitor — never somebody else,
 *   · a token we CAN read must never overwrite what this origin already knows,
 *   · and nothing here may ever throw, because the middleware re-throws and a storefront that is
 *     otherwise perfectly healthy would answer 500.
 *
 * The last one is not hypothetical. `readHandoff` signs through `requiredSecret('AUTH_SECRET', …)`,
 * which throws rather than falling back in a production build. A deploy missing that variable still
 * serves every GET page — the CSRF gate only consults it on writes — so the only pages that would
 * have broken are the ones arriving from a seller's own domain, i.e. precisely the traffic the
 * boundary exists to keep.
 */
import { describe, expect, it } from 'vitest';
import type { AstroCookies } from 'astro';
import { adoptHandoff, signHandoff, HANDOFF_TTL_MS } from '../src/lib/cross-origin-handoff.js';
import { HANDOFF_PARAM } from '../src/lib/platform-routes.js';
import { VISITOR_COOKIE } from '../src/lib/visitor.js';
import { ATTRIBUTION_COOKIE, encodeAttribution, decodeAttribution } from '../src/lib/attribution.js';

/** Just enough of Astro's cookie jar for this function: get, set, and a record of what was set. */
function jar(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const setCalls: string[] = [];
  const cookies = {
    get: (name: string) => (values.has(name) ? { value: values.get(name)! } : undefined),
    set: (name: string, value: string) => { values.set(name, value); setCalls.push(name); },
  } as unknown as AstroCookies;
  return { cookies, values, setCalls };
}

/** `visitor.ts#VISITOR_ID_RE` — 20 lowercase hex characters, not a dashed uuid. */
const VID = 'a1b2c3d4e5f60718293a';
const urlWith = (token: string) => new URL(`https://dezabin.co.il/checkout?${HANDOFF_PARAM}=${encodeURIComponent(token)}`);

/** A real click record, encoded the way `attribution.ts` would have written the cookie. */
const clickCookie = encodeAttribution(decodeAttribution(encodeAttribution({
  source: 'google', gclid: 'CjwK-real', at: new Date().toISOString(),
} as never))!);

describe('a token that cannot be read', () => {
  const cases: [string, string][] = [
    ['forged', 'eyJ2aWQiOiJmYWtlIn0.notasignature'],
    ['empty', ''],
    ['shapeless', 'garbage'],
    ['signature only', '.abc'],
    ['expired', signHandoff({ vid: VID }, Date.now() - HANDOFF_TTL_MS - 1000)],
  ];

  for (const [label, token] of cases) {
    it(`${label} → the shopper is a new visitor, and nothing is granted`, () => {
      const { cookies, setCalls } = jar();
      expect(() => adoptHandoff(urlWith(token), cookies)).not.toThrow();
      // The safe default is EMPTY, not a guess. `resolveVisitorId` runs immediately after this in
      // the middleware and mints a fresh id — the store's conversion figures lose one crossing,
      // which is the correct price for not believing an unsigned claim about who somebody is.
      expect(setCalls).toEqual([]);
    });
  }

  it('leaves an identity this origin already had completely alone', () => {
    const { cookies, values, setCalls } = jar({ [VISITOR_COOKIE]: 'mine-already' });
    adoptHandoff(urlWith('eyJ2aWQiOiJoaWphY2sifQ.forged'), cookies);
    expect(values.get(VISITOR_COOKIE)).toBe('mine-already');
    expect(setCalls).toEqual([]);
  });

  it('does not throw when there is no parameter at all — the overwhelmingly common case', () => {
    const { cookies, setCalls } = jar();
    expect(() => adoptHandoff(new URL('https://dezabin.co.il/checkout'), cookies)).not.toThrow();
    expect(setCalls).toEqual([]);
  });
});

describe('a token we minted', () => {
  it('fills in a visitor id this origin does not have', () => {
    const { cookies, values } = jar();
    adoptHandoff(urlWith(signHandoff({ vid: VID })), cookies);
    expect(values.get(VISITOR_COOKIE)).toBe(VID);
  });

  it('never OVERWRITES one it does — the cookie here is the more recent truth', () => {
    // The shopper was on the platform before crossing. Their id on this origin is the one every
    // figure in the seller's dashboard is already keyed on; replacing it with the one they carried
    // would split one shopper into two in the direction that makes the mall look useless.
    const { cookies, values } = jar({ [VISITOR_COOKIE]: 'was-here-first' });
    adoptHandoff(urlWith(signHandoff({ vid: VID })), cookies);
    expect(values.get(VISITOR_COOKIE)).toBe('was-here-first');
  });

  it('never overwrites an attribution cookie either — a fresher click outranks a carried one', () => {
    // `attribution.ts` replaces a click record whole on a genuine landing and never merges. A token
    // minted up to ten minutes ago must not undo a click that happened since.
    const { cookies, values } = jar({ [ATTRIBUTION_COOKIE]: clickCookie });
    adoptHandoff(urlWith(signHandoff({ attr: encodeAttribution({ source: 'meta', at: new Date().toISOString() } as never) })), cookies);
    expect(values.get(ATTRIBUTION_COOKIE)).toBe(clickCookie);
  });

  it('is idempotent — replayed inside its window it changes nothing the second time', () => {
    const token = signHandoff({ vid: VID });
    const { cookies, setCalls } = jar();
    adoptHandoff(urlWith(token), cookies);
    adoptHandoff(urlWith(token), cookies);
    expect(setCalls).toEqual([VISITOR_COOKIE]);
  });

  it('refuses an attribution payload that is signed but not decodable', () => {
    // A signature proves we wrote the string, never that the record inside it is well-formed. The
    // cookie this origin ends up holding has to be one `readAttribution` will accept at checkout,
    // so a signed-but-unreadable record is dropped rather than passed through.
    const { cookies, setCalls } = jar();
    adoptHandoff(urlWith(signHandoff({ attr: 'bm90LWpzb24' })), cookies);
    expect(setCalls).toEqual([]);
  });
});

describe('a cookie jar that throws', () => {
  it('does not take the page down with it', () => {
    // Stands in for every way the read can fail — a missing AUTH_SECRET in production being the
    // concrete one. The middleware re-throws what it catches, so this is the difference between a
    // shopper losing an analytics id and a shopper losing the page.
    const hostile = {
      get: () => { throw new Error('cookie jar unavailable'); },
      set: () => { throw new Error('cookie jar unavailable'); },
    } as unknown as AstroCookies;
    expect(() => adoptHandoff(urlWith(signHandoff({ vid: VID })), hostile)).not.toThrow();
  });
});
