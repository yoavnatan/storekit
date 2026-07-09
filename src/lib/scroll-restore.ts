const PREFIX = 'store_scroll_';

interface StoreScrollState {
  scrollY: number;
  search: string; // the store's filter/sort/search query string active when the user left
}

export function saveStoreScroll(slug: string, search: string): void {
  try {
    const state: StoreScrollState = { scrollY: window.scrollY, search };
    sessionStorage.setItem(PREFIX + slug, JSON.stringify(state));
  } catch {}
}

// Restoring the last scroll/filter state only makes sense when the user is
// actually coming back from *within* this store's own journey — its own
// product page, or checkout. Arriving any other way (homepage, search,
// an external link, a different store, a bookmark) should land at the top
// like a normal first visit, even if a stale save is still sitting in
// sessionStorage from an earlier, unrelated visit this same tab session.
function isLegitReturn(slug: string): boolean {
  try {
    const ref = new URL(document.referrer);
    if (ref.origin !== location.origin) return false;
    return ref.pathname.startsWith(`/store/${slug}/`) || ref.pathname.startsWith('/checkout');
  } catch {
    return false;
  }
}

// Call before the page reads its own URL params: rewrites the address bar's
// query string to the one active when the user left, so filter/sort/search
// re-apply and the grid's layout matches before scroll position is restored.
export function applyStoreScrollQuery(slug: string): void {
  try {
    if (!isLegitReturn(slug)) return;
    const raw = sessionStorage.getItem(PREFIX + slug);
    if (!raw) return;
    const { search } = JSON.parse(raw) as StoreScrollState;
    if (search && !location.search) {
      history.replaceState(null, '', location.pathname + search);
    }
  } catch {}
}

// Call after filters have been applied and the grid has its final layout.
export function restoreStoreScroll(slug: string): void {
  try {
    const raw = sessionStorage.getItem(PREFIX + slug);
    if (raw === null) return;
    sessionStorage.removeItem(PREFIX + slug);
    if (!isLegitReturn(slug)) return;
    const { scrollY } = JSON.parse(raw) as StoreScrollState;
    // Explicit 'instant', not 'auto' — the site sets a global `scroll-behavior:
    // smooth` on <html> (reset.css), and 'auto' just defers to that CSS value,
    // so it would animate here too instead of snapping to place.
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  } catch {}
}
