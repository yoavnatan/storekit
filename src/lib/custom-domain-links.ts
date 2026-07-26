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
