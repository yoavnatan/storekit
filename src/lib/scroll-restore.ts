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

// Call before the page reads its own URL params: rewrites the address bar's
// query string to the one active when the user left, so filter/sort/search
// re-apply and the grid's layout matches before scroll position is restored.
export function applyStoreScrollQuery(slug: string): void {
  try {
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
    const { scrollY } = JSON.parse(raw) as StoreScrollState;
    // Explicit 'instant', not 'auto' — the site sets a global `scroll-behavior:
    // smooth` on <html> (reset.css), and 'auto' just defers to that CSS value,
    // so it would animate here too instead of snapping to place.
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  } catch {}
}
