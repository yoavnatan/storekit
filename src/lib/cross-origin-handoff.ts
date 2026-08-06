/**
 * Carrying a shopper's identity across the custom-domain → platform boundary.
 *
 * `platform-routes.ts` explains why the boundary exists at all. This is the half that keeps the
 * crossing from erasing what we already knew about the visit, because two of our own first-party
 * cookies are host-scoped and therefore do not survive it:
 *
 *   · `sn_vid` — the visitor id every unique-visitor and conversion figure in the seller's
 *     dashboard is keyed on. Without it, a shopper who browses on the seller's domain and buys on
 *     ours is TWO visitors, and the store's conversion rate is wrong in the direction that makes
 *     the mall look useless.
 *   · `sn_attr` — the ad click (`attribution.ts`). Paid traffic already lands on the platform, so
 *     the common case is safe; a UTM-tagged link a seller shares to their OWN domain is not, and
 *     that record would be lost at the crossing.
 *
 * **Why we carry it ourselves instead of using the analytics vendors' cross-domain linking.** GA4's
 * linker decorates outbound links only for domains listed in the GTM container — a static list,
 * maintained by hand. This platform's whole model is that a seller connects a domain without asking
 * anyone (`custom-domain.ts`), so that list can never be right. A first-party parameter we mint
 * ourselves scales to any number of seller domains and does not depend on a third-party script
 * having loaded.
 *
 * **Why it is signed.** The token names an ad click, and an ad click decides which campaign gets
 * credited with a sale — a number the platform bills against. An unsigned parameter would let
 * anyone hand themselves a `gclid` and write it onto a real order. The visitor id is signed for the
 * same reason a session token is: an arbitrary one is analytics pollution, and pollution that
 * anyone can author is not a metric. HMAC over the payload with `AUTH_SECRET`, namespaced so it can
 * never be confused with a session or CSRF token (`csrf.ts` explains why the namespace matters).
 *
 * **Short-lived on purpose.** The token rides in a URL, so it can be copied out of an address bar
 * and shared. Ten minutes is far longer than a click-to-checkout crossing and far shorter than
 * anything worth replaying — and the payload is a visitor id and a click id, not a session.
 */
import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { requiredSecret } from './runtime-env.js';
import { secretsEqual } from './secret-compare.js';
import { VISITOR_COOKIE, VISITOR_ID_RE } from './visitor.js';
import { ATTRIBUTION_COOKIE } from './attribution.js';
import { store as platform } from '../config/store.config.js';
import { machineUrl, stripTrailingSlashes } from './url-base.js';
import { HANDOFF_PARAM } from './platform-routes.js';

/** Re-exported so a server caller has one import for the whole mechanism. It is DECLARED in
 *  `platform-routes.ts` because the browser needs the name too and cannot hold this module. */
export { HANDOFF_PARAM } from './platform-routes.js';

/** How long a minted token stays valid. */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

/** The visitor id's shape, imported rather than restated (`visitor.ts` owns it). Validated on the
 *  way out as strictly as on the way in: a signature proves WHO wrote a value, never that the value
 *  is well-formed. */
const VID_RE = VISITOR_ID_RE;

/** The attribution cookie is base64url of a JSON record, re-validated in full by
 *  `attribution.ts#decodeAttribution` before anything downstream reads it. All this cap does is
 *  refuse to move an absurd string across the boundary at all. */
const MAX_ATTR = 512;

export interface HandoffPayload {
  /** The platform visitor id the shopper already carried on the seller's domain. */
  vid?: string;
  /** The attribution cookie value, verbatim — decoded and re-validated by its own module. */
  attr?: string;
  /** Expiry, epoch ms. */
  exp: number;
}

function sign(body: string): string {
  return crypto
    .createHmac('sha256', `${requiredSecret('AUTH_SECRET', 'dev-insecure-secret')}::handoff`)
    .update(body)
    .digest('base64url');
}

/**
 * Mint a token, or `''` when there is nothing worth carrying.
 *
 * An empty token is the common case and must stay cheap: most crossings are an anonymous shopper
 * with no ad click, and a link that carries a signature of nothing is noise in the address bar.
 */
export function signHandoff(
  payload: Omit<HandoffPayload, 'exp'>,
  now: number = Date.now(),
): string {
  const vid = payload.vid && VID_RE.test(payload.vid) ? payload.vid : undefined;
  const attr = payload.attr && payload.attr.length <= MAX_ATTR ? payload.attr : undefined;
  if (!vid && !attr) return '';
  const body = Buffer.from(
    JSON.stringify({ ...(vid ? { vid } : {}), ...(attr ? { attr } : {}), exp: now + HANDOFF_TTL_MS }),
    'utf8',
  ).toString('base64url');
  return `${body}.${sign(body)}`;
}

/**
 * Verify and decode. Null for anything that is not a token we minted and is still in date.
 *
 * Order matters: the signature is checked BEFORE the payload is parsed, so malformed JSON from an
 * unsigned string never reaches `JSON.parse` — and the comparison is constant-time (`secret-compare.ts`),
 * because a token is a secret and an early-exit compare leaks it one byte at a time.
 */
export function readHandoff(token: string | null | undefined, now: number = Date.now()): HandoffPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!mac || !secretsEqual(mac, sign(body))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.exp !== 'number' || rec.exp <= now) return null;

  const vid = typeof rec.vid === 'string' && VID_RE.test(rec.vid) ? rec.vid : undefined;
  const attr = typeof rec.attr === 'string' && rec.attr.length <= MAX_ATTR && rec.attr.length > 0
    ? rec.attr
    : undefined;
  if (!vid && !attr) return null;
  return { ...(vid ? { vid } : {}), ...(attr ? { attr } : {}), exp: rec.exp };
}

/** What a store page served on a seller's own domain stamps into its markup for the client-side
 *  boundary (`custom-domain-links.ts#PlatformBoundary`). Minted server-side because both halves
 *  have to be: the origin is not derivable in a browser, and the token is signed with a secret a
 *  browser must never hold. */
export interface PlatformBoundaryData {
  origin: string;
  handoff: string;
  handoffParam: string;
}

/**
 * Where a platform-owned page requested on a seller's domain is sent (`middleware.ts`).
 *
 * `machineUrl` and not a template string, for the reason every redirect in this application uses
 * it — and here it is not theoretical: `/search` is platform-owned, its query is Hebrew on this
 * catalogue (`?q=נעליים`), and a raw Hebrew byte in a `Location` header THROWS. A shopper on a
 * seller's domain searching the mall would have got a 500 instead of a redirect.
 */
export function platformPageUrl(pathname: string, search = ''): string {
  return machineUrl(`${stripTrailingSlashes(platform.url)}${pathname}${search}`);
}

/**
 * Mint the boundary data for THIS page, and mark the page uncacheable when it carries any.
 *
 * **The response headers are a required argument, not an option a call site may forget.** The token
 * names one visitor. A storefront is a public page, and the whole point of putting Cloudflare in
 * front of one is that somebody eventually adds a "cache everything" rule to make it faster — at
 * which point one shopper's HTML, with their visitor id and their ad click inside it, is served to
 * the next thousand people, who then cross to checkout carrying an identity that is not theirs. The
 * seller's conversion figures would be built on it and nothing would look wrong.
 *
 * Nothing caches these pages today (SSR, no cache headers anywhere), so this changes no behaviour
 * now. It is here so that the performance change which WOULD break it cannot land silently — and it
 * costs nothing in the common case, because a visitor with neither cookie gets an empty token and
 * their page stays as cacheable as it ever was.
 */
export function platformBoundaryData(cookies: AstroCookies, responseHeaders: Headers): PlatformBoundaryData {
  const handoff = signHandoff({
    vid: cookies.get(VISITOR_COOKIE)?.value,
    attr: cookies.get(ATTRIBUTION_COOKIE)?.value,
  });
  if (handoff) responseHeaders.set('Cache-Control', 'private, no-store');
  return { origin: stripTrailingSlashes(platform.url), handoff, handoffParam: HANDOFF_PARAM };
}
