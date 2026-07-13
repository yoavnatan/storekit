const PREFIX = 'store_scroll_';

interface StoreScrollState {
  scrollY: number;
  search: string; // the store's filter/sort/search query string active when the user left
  // How many product cards were loaded (via "load more") when the user left. The grid is
  // server-paginated, so restoring scrollY only lands in the right place once load-more has
  // caught back up to at least this many cards — otherwise scrollY points past whatever the
  // fresh page happened to render.
  loadedCount: number;
}

export function saveStoreScroll(slug: string, search: string, loadedCount: number): void {
  try {
    const state: StoreScrollState = { scrollY: window.scrollY, search, loadedCount };
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
// re-apply before scroll position is restored.
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

// Non-destructive read — call once the grid's initial (SSR'd) page is in place,
// to find out whether more pages need loading before scroll position means
// anything. Does NOT clear the saved state; restoreStoreScroll() does that.
export function peekStoreScrollState(slug: string): StoreScrollState | null {
  try {
    if (!isLegitReturn(slug)) return null;
    const raw = sessionStorage.getItem(PREFIX + slug);
    return raw ? (JSON.parse(raw) as StoreScrollState) : null;
  } catch {
    return null;
  }
}

// Call once the grid has caught up to the saved loadedCount (or has no more
// pages to give) — the final step, after which the saved state is discarded.
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
