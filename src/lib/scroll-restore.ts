const PREFIX = 'store_scroll_';
const RETURN_FLAG = 'store_scroll_return';

// Set by the store quick-view modal right before it force-reloads the store when
// a refreshed product URL is dismissed with Back. That scripted reload's referrer
// can't be trusted (it isn't a genuine product→store navigation), so this flag
// tells the restore path the return is legit anyway. Consumed once, then cleared,
// so it can't leak into an unrelated later visit.
export function markStoreScrollReturn(slug: string): void {
  try { sessionStorage.setItem(RETURN_FLAG, slug); } catch { /* noop */ }
}

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
    // Modal quick-view refresh→Back (referrer unreliable, see markStoreScrollReturn).
    if (sessionStorage.getItem(RETURN_FLAG) === slug) return true;
    const ref = new URL(document.referrer);
    if (ref.origin !== location.origin) return false;
    return ref.pathname.startsWith(`/${slug}/`) || ref.pathname.startsWith('/checkout');
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
    if (raw === null) { sessionStorage.removeItem(RETURN_FLAG); return; }
    sessionStorage.removeItem(PREFIX + slug);
    const legit = isLegitReturn(slug);
    sessionStorage.removeItem(RETURN_FLAG); // consumed — never leak to a later visit
    if (!legit) return;
    const { scrollY } = JSON.parse(raw) as StoreScrollState;
    scrollToStable(scrollY);
  } catch {}
}

// A single scrollTo often can't reach the saved offset: at restore time the grid
// is laid out but its images haven't decoded, so the document is still shorter
// than it will be and the browser silently clamps us near the top (measured
// landing at 297 for a saved 2500). Land as close as possible immediately, then
// re-assert every frame until the target is actually reached or the page stops
// growing — never a deferred single jump, which would show the page at the top
// first and only snap into place once the grid finished growing. Bails the
// moment the user scrolls, so a restore can never fight a deliberate gesture.
function scrollToStable(target: number, timeoutMs = 1500): void {
  // Explicit 'instant', not 'auto' — the site sets a global `scroll-behavior:
  // smooth` on <html> (reset.css), and 'auto' just defers to that CSS value,
  // so it would animate here too instead of snapping to place.
  const jump = () => window.scrollTo({ top: target, behavior: 'instant' });
  jump();
  if (Math.abs(window.scrollY - target) < 1) return;

  let done = false;
  const stop = () => {
    done = true;
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchstart', stop);
    window.removeEventListener('keydown', stop);
  };
  window.addEventListener('wheel', stop, { passive: true });
  window.addEventListener('touchstart', stop, { passive: true });
  window.addEventListener('keydown', stop);

  const started = performance.now();
  const step = () => {
    if (done) return;
    jump();
    if (Math.abs(window.scrollY - target) < 1 || performance.now() - started > timeoutMs) { stop(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
