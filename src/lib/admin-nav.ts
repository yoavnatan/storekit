// Shared URL-building for the admin dashboard's paginated list tabs — used
// server-side by admin/index.astro (to build each tab's pager/search-form
// URLs from its current filter state) and client-side by the tab scripts
// (sellers.ts/stores.ts/orders-filter.ts, to navigate on search/sort/filter
// change). One implementation so the two never drift out of sync.
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
  sellers: ['sq', 'ssort', 'sblocked', 'spage', 'snew'],
  // `stblocked` is the retired yes/no form of `ststate` — still parsed (parseStoreQuery) so an
  // older bookmark keeps filtering to blocked stores, so it still has to be owned here or it
  // would be stripped out of the URL before the parser ever saw it.
  stores: ['stq', 'stsort', 'ststate', 'stblocked', 'stpage', 'stnew'],
  orders: ['oq', 'osort', 'oship', 'opay', 'ostore', 'opage', 'onew'],
  attention: ['apage'],
  performance: ['storeQ', 'storeSort', 'storeDir', 'storePage'],
  advertising: ['adpreset', 'adfrom', 'adto'],
  messages: ['msort', 'munread', 'mpage'],
  alerts: ['alsort', 'alsource', 'alstore', 'alpage', 'alnew'],
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
export async function swapPanel(url: string, panelId: string, reinit: () => void): Promise<void> {
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
    reinit();
  } catch {
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
    swapPanel(link.href, panelId, reinit);
  });
}
