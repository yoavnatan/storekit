/**
 * Replace ONE tab panel's contents with the server's answer for that panel — the mechanism behind
 * every filter, sort, chip and pager on the admin dashboard, and behind "fill this seller tab on
 * the click that opens it".
 *
 * It lived in `admin-nav.ts` until the seller dashboard needed the same move (2026-08-11). It is
 * here rather than duplicated because the failure it handles is the interesting part: a fetch or a
 * parse that fails falls back to a REAL navigation to the same URL, which is the one thing
 * guaranteed to produce a filled panel. A second copy would be a second place for that fallback to
 * be forgotten.
 *
 * `panel-freshness` touches no DOM at import time, which is what lets this module keep being
 * imported by `admin/index.astro`'s server-side frontmatter (through `admin-nav.ts`) as well as by
 * the browser scripts.
 */
import { markPanelFresh } from './panel-freshness.js';

/**
 * The "something is happening" signal for a panel swap (owner, 2026-08-07: "add a loader so I can
 * feel the site moving").
 *
 * One indicator here rather than one per tab, because every filter, sort, chip and pager arrow on
 * the admin dashboard already funnels through `swapPanel` — a per-tab spinner would be nine copies
 * of one idea, and the tab that got missed would be the one that felt broken.
 *
 * It is a chip at the top of the panel plus a dimmed, non-interactive panel, NOT a spinner
 * replacing the content: the old rows are still the right answer to the previous question, and
 * blanking them makes a 1-second wait feel like a page that lost its data. The rule this follows is
 * the project's own — a shimmer goes UNDER the content it is loading, never over the top of it.
 *
 * **Nothing is shown for the first 180ms.** A swap that returns quickly should look instant; a
 * spinner that appears and vanishes inside a fifth of a second reads as a flicker, which is worse
 * than no feedback at all. Past that threshold the wait is real and saying so is the honest thing.
 */
const BUSY_DELAY_MS = 180;

function showBusy(panelId: string): () => void {
  const panel = document.getElementById(panelId);
  if (!panel) return () => { /* nothing to undo */ };
  const timer = setTimeout(() => panel.setAttribute('data-busy', ''), BUSY_DELAY_MS);
  return () => {
    clearTimeout(timer);
    panel.removeAttribute('data-busy');
  };
}

export interface PanelSwapOptions {
  /**
   * Show the busy chip while the request is in flight. On by default, and OFF for a panel that is
   * being filled for the first time: there the panel holds a static placeholder, which already
   * says "loading" without a second signal on top of it.
   */
  busy?: boolean;
  /**
   * Put `url` in the address bar once the swap lands. On by default, because on the admin
   * dashboard a swap IS a navigation — a filter, a sort, a page. Off where something else already
   * owns the URL: the seller dashboard's inline tab controller writes `?panel=` itself on every
   * activation, and a push from here would add a duplicate history entry that the back button then
   * has to be pressed twice to get past.
   */
  pushUrl?: boolean;
}

export async function swapPanel(
  url: string,
  panelId: string,
  reinit: () => void,
  { busy = true, pushUrl = true }: PanelSwapOptions = {},
): Promise<void> {
  const doneBusy = busy ? showBusy(panelId) : () => { /* no chip was shown */ };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('bad response');
    const html = await res.text();
    const next = new DOMParser().parseFromString(html, 'text/html').getElementById(panelId);
    const current = document.getElementById(panelId);
    if (!next || !current) throw new Error('panel not found');
    current.innerHTML = next.innerHTML;
    // Only claim the address bar if this panel is still the one on screen. The fetch above
    // re-renders the whole dashboard server-side and can take about a second, which is long enough
    // for the admin to have switched tabs meanwhile — and pushing then put the LEFT tab's URL
    // (`?panel=moneylog&mtype=…`) back over the tab they were now looking at, undoing the cleanup
    // in tab-nav.ts. The content swap still happens either way: the panel is simply ready and
    // correct for their return.
    if (pushUrl && !current.hidden) history.pushState({}, '', url);
    // Stamped HERE rather than at each of the ~dozen call sites that swap a panel — filters, sorts,
    // chips, pagers and the lazy first open all funnel through this one function, and a list of
    // places to remember to stamp is a rule that rots (the same reasoning tab-sync.ts gives for
    // observing `fetch` once). After the swap, so a failed load is never marked fresh.
    markPanelFresh(panelId);
    doneBusy();
    reinit();
  } catch {
    // Not cleared before the assignment: a full navigation is about to replace the document, and
    // removing the busy state first would flash the old panel back to normal on the way out.
    window.location.href = url;
  }
}
