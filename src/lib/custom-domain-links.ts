// Clean in-store URLs on a seller's custom domain (client-side).
//
// The app routes every store at /<slug> internally, so all in-store links are built as
// /<slug>/<product>. On the seller's OWN verified domain the store is served from the root, so that
// /<slug> prefix is redundant and ugly in the address bar (demo.example/<slug>/x instead of
// demo.example/x). These helpers strip it. Purely cosmetic: the server already emits the clean URL
// as <link rel="canonical">, so SEO is unaffected either way.

/** '' when the page is served on the store's own verified custom domain (store lives at root),
 *  otherwise the platform prefix '/<slug>'. Single source of truth for building in-store URLs. */
export function storeBasePath(slug: string, customHost: string): string {
  return isOnCustomHost(customHost) ? '' : `/${slug}`;
}

/** True when the current page is being served on the given (verified) custom hostname. */
export function isOnCustomHost(customHost: string): boolean {
  return Boolean(customHost) && location.hostname.toLowerCase() === customHost.toLowerCase();
}

/**
 * The mirror image of `initCustomDomainLinks`, for the one session that must NOT reach the custom
 * domain: an ad landing.
 *
 * **The crossing this closes (found 2026-08-06).** A store on a verified custom domain is advertised
 * on the PLATFORM domain — the only one the Merchant/Business account can claim — and the store
 * pages stand their 301 down when they see `?ad=1` (custom-domain.ts#AD_LANDING_PARAM). That
 * exemption was per-REQUEST, so it covered the landing and nothing after it: every in-store link on
 * that page is `/<slug>/…` with no marker, and the first click 301s the shopper onto the seller's
 * domain — a second origin, where the cart's localStorage and the session cookie do not exist
 * (memory `project_custom_domain_origin_split`). A paid click could therefore add to cart and lose
 * it on the very next navigation, and only for the sellers who took the trouble to verify a domain.
 *
 * Carrying the marker forward keeps the whole ad session on one origin. It costs the seller
 * nothing: these URLs are `noindex` by the same rule the landing is, so the organic ranking still
 * consolidates on their domain exactly as before — an ad click was never contributing to it.
 *
 * Client-side, in this module, because this is the same job it already does — adjust in-store hrefs
 * for the host the page is being served on — and because the MutationObserver below is what makes
 * it reach load-more results, the quick-view modal and related products, none of which exist when
 * the page is rendered. A shopper with JS disabled crosses as before and loses nothing, since the
 * cart they would lose is itself localStorage.
 */
export function initAdLandingLinks(slug: string, isAdLanding: boolean): void {
  if (!slug || !isAdLanding) return;
  const prefix = `/${slug}`;
  const mark = (a: Element): void => {
    const href = a.getAttribute('href');
    if (!href) return;
    const [path, hash = ''] = href.split('#', 2);
    // In-store links only, and matched on the PATH — `/acme?category=shoes` is the store page's
    // own category link and is the most-clicked link on a brand-campaign landing, but it is
    // neither equal to `/acme` nor prefixed by `/acme/`, so comparing the whole href silently
    // skipped exactly the links that matter most. `/checkout`, `/`, another store and anything
    // absolute stay untouched: they are already on this origin or deliberately elsewhere, and a
    // marker their target ignores would only pollute the URL.
    const [pathname, query = ''] = path!.split('?', 2);
    if (pathname !== prefix && !pathname!.startsWith(prefix + '/')) return;
    if (/(^|&)ad=1(&|$)/.test(query)) return;
    a.setAttribute('href', `${path}${query ? '&' : '?'}ad=1${hash ? `#${hash}` : ''}`);
  };
  const scan = (root: ParentNode): void => root.querySelectorAll('a[href]').forEach(mark);
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches?.('a[href]')) mark(el);
        scan(el);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

/** Strips the redundant '/<slug>' prefix from every in-store <a href> when on the custom domain,
 *  so the URL bar shows clean root-relative paths. Also stamps window.__customStoreHost so the
 *  shared product modal can build its pushState URL the same way. Covers dynamically-added links
 *  (load-more, modal content, related products) via a MutationObserver. No-op off the custom host. */
export function initCustomDomainLinks(slug: string, customHost: string): void {
  window.__customStoreHost = customHost || '';
  if (!slug || !isOnCustomHost(customHost)) return;
  const prefix = `/${slug}`;
  const strip = (a: Element): void => {
    const href = a.getAttribute('href');
    if (href === prefix) a.setAttribute('href', '/');
    else if (href && href.startsWith(prefix + '/')) a.setAttribute('href', href.slice(prefix.length));
  };
  const scan = (root: ParentNode): void => root.querySelectorAll('a[href]').forEach(strip);
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches?.('a[href]')) strip(el);
        scan(el);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}
