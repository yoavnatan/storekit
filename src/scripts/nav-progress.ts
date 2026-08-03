import { startLoadingSweep, stopLoadingSweep, LOADING_CUE_DELAY_MS } from '../lib/loading-sweep.js';

/**
 * Says "the next page is coming" during a full navigation.
 *
 * This site is a multi-page app on purpose (View Transitions were investigated and
 * reverted — AI_INSTRUCTIONS → Architecture), and the cost of that is this gap: from
 * the click until the server answers, the browser just holds the old paint. Nothing
 * in the page moves, nothing says a request is in flight, and the tab spinner is not
 * where anyone is looking. `/stores` → `/` is a couple of seconds of that, and it
 * reads as a dead click rather than a slow one (owner, 2026-08-03).
 *
 * It reuses the bar the rest of the site already uses for waiting — `.progress-sweep`
 * in a `.progress-track`, the same one behind the store grid's filters and the seller
 * dashboard's hydration — pinned under the fixed header. A wait should look the same
 * everywhere; a bespoke navigation spinner would be a second vocabulary for one case.
 *
 * **It only appears if the wait is real.** Two delays stack, and both are deliberate:
 * this module waits `LOADING_CUE_DELAY_MS` before inserting anything, and the sweep's
 * own wrapper then fades in over 250ms more. A navigation that answers quickly — most
 * of them, and every bfcache "back" — is finished long before either, so nothing is
 * ever drawn. That is the difference between a cue and a flicker.
 *
 * There is no teardown for the success case: the document is replaced wholesale.
 * `pageshow` is the one that matters — a bfcache restore brings back the DOM exactly
 * as it left, bar and all, so a "back" out of a slow page would otherwise return to a
 * page that appears to be permanently loading.
 */
export function initNavProgress(): void {
  const track = document.getElementById('nav-progress');
  if (!track) return;

  let timer = 0;

  const cancel = () => {
    window.clearTimeout(timer);
    stopLoadingSweep(track);
  };

  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => startLoadingSweep(track), LOADING_CUE_DELAY_MS);
  };

  document.addEventListener('click', (event) => {
    // Listening on the document (bubble phase) means every handler on the link itself
    // has already run — so `defaultPrevented` is trustworthy here, and that matters:
    // product cards, quick-view triggers and the logo's already-home guard are all
    // real <a href> elements whose click never becomes a navigation.
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;

    let url: URL;
    try { url = new URL(link.href, window.location.href); } catch { return; }
    // Off-site, a scheme the page does not navigate with (mailto:, tel:), or an
    // in-page anchor — none of these replace the document.
    if (url.origin !== window.location.origin) return;
    if (url.href.replace(/#.*$/, '') === window.location.href.replace(/#.*$/, '')) return;

    arm();
  });

  // A real POST — checkout, logout — is a navigation too, and a slow one.
  document.addEventListener('submit', (event) => {
    if (!event.defaultPrevented) arm();
  });

  // Restored from bfcache: the page comes back exactly as it was, which for a "back"
  // out of a slow navigation means the bar is still running. Nothing is loading now.
  window.addEventListener('pageshow', cancel);

  // Escape is the browser's own "stop loading". Without this the bar would keep
  // claiming a request that the user just cancelled — the same permanent-false-claim
  // the image skeletons had (lib/img-skeleton.ts), and worth not repeating.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
}
