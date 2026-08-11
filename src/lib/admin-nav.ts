// Shared URL-building for the admin dashboard's paginated list tabs — used
// server-side by admin/index.astro (to build each tab's pager/search-form
// URLs from its current filter state) and client-side by the tab scripts
// (sellers.ts/stores.ts/orders-filter.ts, to navigate on search/sort/filter
// change). One implementation so the two never drift out of sync.
// `panel-freshness` touches no DOM at import time, which is what lets this module keep being
// imported by admin/index.astro's server-side frontmatter as well as by the browser scripts.
import { markPanelFresh } from './panel-freshness.js';

export function buildAdminUrl(panel: string, params: Record<string, string | undefined>): string {
  const qp = new URLSearchParams();
  qp.set('panel', panel);
  for (const [k, v] of Object.entries(params)) {
    if (v) qp.set(k, v);
  }
  return `/admin?${qp.toString()}`;
}

// Which query params belong to which admin tab. Every tab's filter/sort/pager
// state lives in the ONE shared `/admin?` URL, so without an owner per param a
// tab's state trails the admin into every other tab: `?mtype=…` from the money
// journal stayed in the address bar through Sellers, Orders and Stores, and came
// back on the next reload as a filter nobody asked for (owner, סשן ד׳).
// `tests/admin-tab-params.test.ts` scans the admin page + its query parsers and
// fails if a param is read but unclaimed here, so a new filter can't silently
// start leaking again.
export const ADMIN_TAB_PARAMS: Record<string, readonly string[]> = {
  overview: [],
  data: ['datapreset'],
  // `spayout` arrived when the payouts tab's per-seller table was folded into these cards
  // (סשן א׳ §3): the tiles there are counts, and this is what turns one back into the names.
  sellers: ['sq', 'ssort', 'sblocked', 'spayout', 'spage', 'snew'],
  // `stblocked` is the retired yes/no form of `ststate` — still parsed (parseStoreQuery) so an
  // older bookmark keeps filtering to blocked stores, so it still has to be owned here or it
  // would be stripped out of the URL before the parser ever saw it.
  // `stempty` is the retired "לתשומת לב" TAB (סשן ב׳ §1) — one thing that tab could say, said as a
  // filter on the list it was always about.
  stores: ['stq', 'stsort', 'ststate', 'stblocked', 'stempty', 'stpage', 'stnew'],
  orders: ['oq', 'osort', 'oship', 'opay', 'ostore', 'opage', 'onew'],
  performance: ['storeQ', 'storeSort', 'storeDir', 'storePage'],
  advertising: ['adpreset', 'adfrom', 'adto'],
  messages: ['msort', 'munread', 'mpage'],
  alerts: ['alsort', 'alsource', 'alsev', 'alref', 'alq', 'alstore', 'alfrom', 'alto', 'alpage', 'alnew'],
  // No params of its own since סשן א׳ §3 — the per-seller table it paged now lives on the seller
  // cards. The key stays so `stripForeignTabParams` still knows this tab exists; an empty list is
  // the honest description, not an omission.
  payouts: [],
  // The accounting statement's period: a month key, or a free range. `ac*` rather than `st*` —
  // every store-tab param already starts `st`, and two tabs whose params are told apart by the
  // third letter is how one of them ends up owned by the wrong list.
  statement: ['acmonth', 'acfrom', 'acto'],
  moneylog: ['mtype', 'mlpage', 'mq', 'mfrom', 'mto', 'mev'],
};

/** Drops every OTHER tab's params from `url`, keeping `panel` and the params the
 *  now-active tab owns. Deleting only foreign params (rather than everything but
 *  `panel`) is what lets a deep link like `?panel=orders&oq=דני` survive the admin
 *  clicking into Sellers and back. */
export function stripForeignTabParams(url: URL, activePanel: string): URL {
  for (const [tab, params] of Object.entries(ADMIN_TAB_PARAMS)) {
    if (tab === activePanel) continue;
    for (const param of params) url.searchParams.delete(param);
  }
  return url;
}

// A plain `.join(',')`/`.split(',')` corrupts multi-value filter params (e.g.
// Orders' store filter) the moment a value itself contains a comma — a store
// name is free text a seller sets (see stores.ts's createStore/updateStore,
// no comma restriction), so encode each value before joining and decode each
// after splitting.
export function encodeList(values: string[]): string {
  return values.map(encodeURIComponent).join(',');
}

export function decodeList(raw: string): string[] {
  return raw.split(',').filter(Boolean).map((v) => decodeURIComponent(v));
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Search/sort/filter/pager used to always `window.location.href` to the
// updated query — simple, and correct since the server already computes the
// page — but reloading the *entire* page (header, every other tab) just to
// replace one panel's rows read as a jarring full-page flash on every search
// keystroke (see CURRENT_TASK.md, 2026-07-15 feedback). swapPanel() fetches
// the same URL a full nav would already load, swaps only the named tab
// panel's innerHTML, and updates the address bar via pushState so the URL
// still reflects real navigation state. Falls back to a real navigation on
// any fetch/parse failure so the feature never silently does nothing.
/**
 * The "something is happening" signal for every panel swap (owner, 2026-08-07: "add a loader so I
 * can feel the site moving").
 *
 * One indicator here rather than one per tab, because every filter, sort, chip and pager arrow on
 * this dashboard already funnels through `swapPanel` — a per-tab spinner would be nine copies of
 * one idea, and the tab that got missed would be the one that felt broken.
 *
 * It is a bar at the top of the panel plus a dimmed, non-interactive panel, NOT a spinner replacing
 * the content: the old rows are still the right answer to the previous question, and blanking them
 * makes a 1-second wait feel like a page that lost its data. The rule this follows is the project's
 * own — a shimmer goes UNDER the content it is loading, never over the top of it.
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

export async function swapPanel(url: string, panelId: string, reinit: () => void): Promise<void> {
  const doneBusy = showBusy(panelId);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('bad response');
    const html = await res.text();
    const next = new DOMParser().parseFromString(html, 'text/html').getElementById(panelId);
    const current = document.getElementById(panelId);
    if (!next || !current) throw new Error('panel not found');
    current.innerHTML = next.innerHTML;
    // Only claim the address bar if this panel is still the one on screen. The
    // fetch above re-renders the whole dashboard server-side and can take about a
    // second, which is long enough for the admin to have switched tabs meanwhile —
    // and pushing then put the LEFT tab's URL (`?panel=moneylog&mtype=…`) back over
    // the tab they were now looking at, undoing the cleanup in tab-nav.ts. The
    // content swap still happens either way: the panel is simply ready and correct
    // for their return.
    if (!current.hidden) history.pushState({}, '', url);
    // Stamped HERE rather than at each of the ~dozen call sites that swap a panel — filters,
    // sorts, chips, pagers and the lazy first open all funnel through this one function, and a
    // list of places to remember to stamp is a rule that rots (the same reasoning tab-sync.ts
    // gives for observing `fetch` once). After the swap, so a failed load is never marked fresh.
    markPanelFresh(panelId);
    doneBusy();
    reinit();
  } catch {
    // Not cleared before the assignment: a full navigation is about to replace the document, and
    // removing the busy state first would flash the old panel back to normal on the way out.
    window.location.href = url;
  }
}

// Back/forward through swapPanel-driven history entries isn't worth tracking
// client-side (each panel would need its own popstate-restore logic) — a
// real reload on the rare back/forward click resyncs everything correctly.
// Guarded so importing this from multiple tab scripts only wires it once.
let popstateWired = false;
export function wirePopstateReload(): void {
  if (popstateWired) return;
  popstateWired = true;
  window.addEventListener('popstate', () => window.location.reload());
}

// Intercepts clicks on same-tab internal links (AdminPager's prev/next —
// anything pointing back at this tab's own `/admin?panel=...` URL) so
// pagination also goes through swapPanel instead of a full reload. Bound
// once to the stable panel container (never replaced, only its innerHTML
// is), so — unlike per-row listeners — this survives every swap without
// needing to be re-wired from `reinit`.
export function wirePanelLinks(panelId: string, reinit: () => void): void {
  const panel = document.getElementById(panelId);
  if (!panel || panel.dataset.linksWired) return; // container survives every swap — wire once, not per reinit
  panel.dataset.linksWired = '1';
  const panelTab = panelId.replace(/^dash-panel-/, '');
  panel.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a[href^="/admin?"]') as HTMLAnchorElement | null;
    if (!link || link.target) return;
    // Only intercept links that stay within THIS panel's own tab. A link to a
    // different tab (e.g. a Sellers-tab store row linking into panel=stores)
    // must fall through to a real navigation so the active tab actually
    // switches — swap-ing another tab's URL into this panel would just reload
    // this same panel and never leave it.
    const targetPanel = new URL(link.href, location.origin).searchParams.get('panel');
    if (targetPanel && targetPanel !== panelTab) return;
    e.preventDefault();
    // `void`: a click handler cannot await, and the swap reports its own failure. Marked
    // explicitly so it reads as a decision — see tests/async-lib-awaited.test.ts.
    void swapPanel(link.href, panelId, reinit);
  });
}
