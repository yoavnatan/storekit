// In-store URLs on a seller's custom domain, and the boundary where they stop being in-store.
//
// Two jobs, and the second is the load-bearing one:
//
//  1. **Cosmetic.** The app routes every store at /<slug> internally, so all in-store links are
//     built as /<slug>/<product>. On the seller's OWN verified domain the store is served from the
//     root, so that prefix is redundant and ugly in the address bar (demo.example/<slug>/x instead
//     of demo.example/x). These helpers strip it. The server already emits the clean URL as
//     <link rel="canonical">, so SEO is unaffected either way.
//
//  2. **The origin boundary** (`platform-routes.ts` carries the decision and the reasoning). A
//     custom domain is a different browser origin: a separate cookie jar and a separate
//     `localStorage`. The cart, the login and the checkout live on the platform, so a relative
//     `/checkout` link on this page would land the shopper in a second, empty world — logged out,
//     basket gone, ad click forgotten. Those links are rewritten to absolute platform URLs here, in
//     the page, so the crossing happens on the click itself rather than as a redirect the shopper
//     waits through. The middleware redirects the same paths as a floor under a middle-click, a
//     bookmark or a page whose script never ran; this layer is the only one that can carry state,
//     because the cart exists nowhere but in this origin's `localStorage`.

import { isPlatformOwnedPath } from './platform-routes.js';
import { CART_FRAGMENT_KEY, encodeHandoffCart } from './cart-handoff.js';
import { readStoreCartForHandoff } from './cart.js';

/** '' when the page is served on the store's own verified custom domain (store lives at root),
 *  otherwise the platform prefix '/<slug>'. Single source of truth for building in-store URLs. */
export function storeBasePath(slug: string, customHost: string): string {
  return isOnCustomHost(customHost) ? '' : `/${slug}`;
}

/** True when the current page is being served on the given (verified) custom hostname. */
export function isOnCustomHost(customHost: string): boolean {
  return Boolean(customHost) && location.hostname.toLowerCase() === customHost.toLowerCase();
}

/** What the page hands this module about the platform on the other side of the boundary. Both
 *  values are stamped server-side by the store and product pages: the origin because the client
 *  cannot derive it, and the token because it is signed with a secret a browser must never hold. */
export interface PlatformBoundary {
  /** Absolute origin, e.g. `https://dezabin.co.il`. */
  origin: string;
  /** Signed visitor-id + ad-attribution carry-over (`cross-origin-handoff.ts`). May be ''. */
  handoff: string;
  /** The query parameter the handoff travels under. */
  handoffParam: string;
}

/** Read what the server stamped, tolerating its absence — the attribute is only emitted for a store
 *  that HAS a verified custom domain, so on the platform itself there is nothing to read and
 *  nothing to do. Never throws on a malformed value: a boundary we cannot parse must leave the page
 *  working with relative links, not break it. */
export function readPlatformBoundary(el: HTMLElement | null | undefined): PlatformBoundary | undefined {
  const raw = el?.dataset.platformBoundary;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<PlatformBoundary>;
    if (!parsed?.origin || !parsed.handoffParam) return undefined;
    return { origin: parsed.origin, handoff: parsed.handoff ?? '', handoffParam: parsed.handoffParam };
  } catch {
    return undefined;
  }
}

/**
 * The absolute platform URL for a root-relative path, with everything that has to travel attached.
 *
 * Cart in the FRAGMENT, identity in the QUERY, and the split is the point: the server needs the
 * identity because it sets the cookies, and must never receive the basket — which a fragment
 * guarantees, since it is not sent, not logged and not proxied (`cart-handoff.ts`).
 */
function platformHref(path: string, boundary: PlatformBoundary, storeSlug: string): string {
  const url = new URL(path, boundary.origin);
  if (boundary.handoff) url.searchParams.set(boundary.handoffParam, boundary.handoff);
  // Only the checkout needs the basket. Every other platform link is a page the shopper is simply
  // navigating to, and a cart in its URL would be a payload nobody reads, travelling for no reason.
  if (url.pathname === '/checkout') {
    const cart = readStoreCartForHandoff(storeSlug);
    if (cart) url.hash = `${CART_FRAGMENT_KEY}=${encodeHandoffCart(cart)}`;
  }
  return url.href;
}

/** Strips the redundant '/<slug>' prefix from every in-store <a href> when on the custom domain, so
 *  the URL bar shows clean root-relative paths, and sends every PLATFORM-owned link to the platform
 *  origin. Also stamps window.__customStoreHost so the shared product modal can build its pushState
 *  URL the same way. Covers dynamically-added links (load-more, modal content, related products,
 *  the cart drawer's own re-render) via a MutationObserver — which is also what keeps the checkout
 *  link's cart fragment current, since the drawer redraws itself on every `cart:change`. No-op off
 *  the custom host. */
export function initCustomDomainLinks(slug: string, customHost: string, boundary?: PlatformBoundary): void {
  window.__customStoreHost = customHost || '';
  if (!slug || !isOnCustomHost(customHost)) return;
  const prefix = `/${slug}`;
  const strip = (a: Element): void => {
    const href = a.getAttribute('href');
    if (href === prefix) a.setAttribute('href', '/');
    else if (href && href.startsWith(prefix + '/')) a.setAttribute('href', href.slice(prefix.length));
  };
  const cross = (a: Element): void => {
    if (!boundary?.origin) return;
    const href = a.getAttribute('href');
    // Root-relative only. `//evil.example` is protocol-relative and is NOT ours to rewrite; an
    // already-absolute href was decided by whoever wrote it.
    if (!href || href[0] !== '/' || href[1] === '/') return;
    if (!isPlatformOwnedPath(href)) return;
    a.setAttribute('href', platformHref(href, boundary, slug));
  };
  const apply = (a: Element): void => { strip(a); cross(a); };
  const scan = (root: ParentNode): void => root.querySelectorAll('a[href]').forEach(apply);
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches?.('a[href]')) apply(el);
        scan(el);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
