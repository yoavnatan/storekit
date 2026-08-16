/**
 * Which top-level paths belong to the PLATFORM even when the request arrives on a seller's own
 * domain — the one list the middleware and the browser both read.
 *
 * **The decision behind it (2026-08-06).** A verified custom domain is a different browser ORIGIN.
 * The cart is `localStorage` and the session is a host-scoped cookie, so neither crosses, and the
 * industry's old workarounds for that (third-party cookies, cross-origin storage) are gone —
 * Safari's ITP and Chrome's storage partitioning killed them. So the store is sovereign for
 * BROWSING and the platform owns the TRANSACTION: `shop.acme.co.il` shows the shop, and the cart,
 * the login and the checkout live on `dezabin.co.il`. That is the same split Shopify runs, and it
 * is the only one that keeps a shopper's multi-store cart intact when they cross.
 *
 * It also closes an attribution hole that predates the decision: `/api/checkout` reads the ad-click
 * cookie (`attribution.ts`), which is written on the PLATFORM origin because every ad landing is a
 * platform URL by design (`custom-domain.ts#AD_LANDING_PARAM`). A checkout completed on a seller's
 * origin could never see it, so every such purchase was silently unattributed.
 *
 * **This module has no imports on purpose.** The rule is enforced twice — the middleware redirects
 * these paths off a custom host, and `custom-domain-links.ts` rewrites their links in the page
 * before a click ever happens — and the second of those runs in the browser. A list that cannot be
 * shared is a list that drifts, which is the failure this file exists to prevent.
 */

/**
 * Platform-owned first path segments. Everything here is a PAGE a shopper or seller navigates to.
 *
 * The complement matters as much and is enumerated in {@link HOST_LOCAL_SEGMENTS}: a path that
 * serves the page currently being rendered — its API calls, its assets, its own machine files —
 * must stay on the host that is serving it, or the store page breaks the moment it is served from
 * a custom domain.
 */
export const PLATFORM_PAGE_SEGMENTS: readonly string[] = [
  'checkout', 'cart', 'wishlist', 'account',
  'buyer', 'seller', 'admin',
  'stores', 'search', 'store',
  // 'returns-policy' is the platform's, like 'terms': it is ONE policy for every shop (decisions §2),
  // so a buyer on a seller's custom domain must read the platform's copy and not a per-host one.
  'terms', 'contact', 'returns-policy',
];

/**
 * Reserved segments that must NOT be redirected — they belong to whichever host is serving.
 *
 * · `api` — the store page fetches its own endpoints relatively; redirecting those cross-origin
 *   would turn every quick-view, cart price check and search into a CORS failure.
 * · `_astro` / `_image` / `_actions` / `favicon` — the assets of the page being rendered.
 * · `robots` / `llms` / `sitemap-content` — deliberately per-host (see `src/pages/robots.txt.ts`);
 *   sending a crawler on the seller's domain to the platform's copy is the exact bug that file
 *   was rewritten to fix.
 * · `404` / `store-unavailable` / `store-gone` — the store's own states, rendered by `Astro.rewrite`
 *   without changing the URL. A shopper who sees one has not left the store.
 * · `index` — never a real path segment.
 */
export const HOST_LOCAL_SEGMENTS: readonly string[] = [
  'api', '_astro', '_image', '_actions', 'favicon',
  'robots', 'llms', 'sitemap-content',
  '404', 'store-unavailable', 'store-gone', 'index',
];

const PLATFORM_SET = new Set(PLATFORM_PAGE_SEGMENTS);

/**
 * True when this path is the platform's to serve, whatever host it arrived on.
 *
 * Takes a pathname, not a segment, because both call sites have a whole path and the first-segment
 * rule is the thing worth stating once: `/buyer/dashboard` and `/buyer` are the same answer, and a
 * store's product page (`/blue-widget`) must never be one.
 */
export function isPlatformOwnedPath(pathname: string): boolean {
  // Query and hash come off FIRST. One caller hands over a real `URL.pathname`; the other hands
  // over an `href` attribute straight out of the markup, and the cart drawer writes
  // `/checkout?store=acme`. Reading that as the segment `checkout?store=acme` matched nothing, so
  // the single most important link on the boundary would have been the one left behind.
  const path = pathname.split('#', 1)[0]!.split('?', 1)[0]!;
  const seg = path.replace(/^\/+/, '').split('/', 1)[0] ?? '';
  return seg !== '' && PLATFORM_SET.has(seg.toLowerCase());
}

/**
 * The query parameter the signed identity carry-over travels under (`cross-origin-handoff.ts`).
 *
 * It lives HERE, beside the routes it decorates, and not in the module that mints it, for one
 * mechanical reason: minting needs `node:crypto`, and the browser also has to know the name — to
 * attach it on the way out and to strip it on the way in. A constant is the only part of that
 * module a client can safely hold, so it is the part that moved.
 */
export const HANDOFF_PARAM = 'h';
