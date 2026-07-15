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
    history.pushState({}, '', url);
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
  panel.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('a[href^="/admin?"]') as HTMLAnchorElement | null;
    if (!link || link.target) return;
    e.preventDefault();
    swapPanel(link.href, panelId, reinit);
  });
}
