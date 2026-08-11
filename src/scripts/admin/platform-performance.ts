import { formatPrice } from '../../config/store.config.js';
import { showActionFailedToast } from '../../lib/toast.js';

/** Integer agorot → ILS on screen. Server twin: `money.ts#formatAgorot`. Every money field on a
 *  performance summary is agorot since the `orders` migration, so a bare `formatPrice` on one
 *  prints a figure a hundred times too large. */
function fmtAgorot(agorot: number): string { return formatPrice(agorot / 100); }

import { rowStateBadge } from '../../lib/store-state-badge.js';
import { escapeHtml as escHtml } from '../../lib/html-escape.js';
import type { PerformanceSummary } from '../../lib/seller-performance.js';
import type { PlatformStoreRow, StoreRowsQuery, StoreSortCol } from '../../lib/platform-performance.js';
import { renderTopProducts } from '../dashboard/performance.js';
import type { PlatformRevenue } from '../../lib/platform-revenue.js';

// Admin-only glue for the platform performance tab's per-store breakdown table
// and the two money cards. The charts + KPIs + top-products + range picker +
// revenue-breakdown donut are all driven by the SHARED performance.ts (via
// #perf-range-picker[data-endpoint]); this module only owns the pieces that are
// platform-specific and have no equivalent on the seller tab.
//
// The table is a SERVER-paged view: search / sort / page changes re-fetch just
// this table from the same endpoint and swap the tbody, so the client never
// holds more than one page of rows (this has to survive 1000 stores) and the
// dashboard never reloads. It stays in sync with the range picker by listening
// for the `perf:loaded` event performance.ts dispatches after every range fetch,
// and by pinning its own params onto that fetch via `dataset.extraParams`.

interface LoadedDetail {
  summary?: PerformanceSummary;
  revenue?: PlatformRevenue;
  stores?: PlatformStoreRow[];
  totalStores?: number;
  storeTotal?: number;
  storeMatched?: number;
  storePage?: number;
  storeTotalPages?: number;
  productsMatched?: number;
}

const SEARCH_DEBOUNCE_MS = 250;

let state: StoreRowsQuery = { q: '', sort: 'revenue', dir: 'desc', page: 1 };
// The leaderboard's own name search, kept beside the table's because both ride on the same fetch:
// pinned onto every range change (`dataset.extraParams`) so switching the period keeps the search,
// and sent on every table fetch so one response can refresh both halves.
let productQ = '';
let i18n: Record<string, string> = {};
let picker: HTMLElement | null = null;

function readI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function fill(key: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), i18n[key] ?? '');
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ── Store breakdown table ────────────────────────────────────────────────────

function rowHtml(s: PlatformStoreRow): string {
  // Same map the SSR panel renders from (lib/store-state-badge.ts) — this table is redrawn on the
  // client when the range changes, so a private copy here is how the two would come to disagree
  // about a store the SSR pass had already labelled. Falls back to the legacy `blocked` flag for
  // a row served by an older deploy mid-rollout.
  const badge = rowStateBadge(s);
  const blocked = badge ? ` <span class="admin-badge admin-badge--${badge.variant}" style="margin-inline-start:0.4rem">${badge.label}</span>` : '';
  // Only ever visible in search results (browsing filters these out) — it says
  // "this store exists, it just did nothing in this range", so four zero columns
  // don't read as missing data.
  const idle = s.active ? '' : `<span class="block text-[0.72rem] [color:var(--color-muted)]">${i18n.perfStoreNoActivity ?? ''}</span>`;
  return `<tr>
    <td><a href="/admin/store/${encodeURIComponent(s.slug)}/performance?from=performance" class="admin-link font-medium">${escHtml(s.name)}</a>${blocked}${idle}</td>
    <td>${escHtml(fmtAgorot(s.revenueAgorot))}</td>
    <td>${s.orders}</td>
    <td>${s.views}</td>
    <td>${s.conversionRate.toFixed(1)}%</td>
  </tr>`;
}

/** Reflect the active sort on the header: aria-sort for a11y + a caret that shows
 *  only on the active column and points up (asc) / down (desc). */
function syncHeaders(): void {
  document.querySelectorAll<HTMLButtonElement>('#platform-store-table [data-sort-col]').forEach((btn) => {
    const th = btn.closest('th');
    const caret = btn.querySelector<SVGElement>('.perf-sort-caret');
    const active = btn.dataset.sortCol === state.sort;
    if (th) th.setAttribute('aria-sort', active ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    if (caret) {
      caret.style.opacity = active ? '1' : '0';
      caret.style.transform = active && state.dir === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
    }
  });
}

function renderTable(detail: LoadedDetail): void {
  const tbody = document.getElementById('platform-store-rows');
  if (!tbody) return;
  const rows = detail.stores ?? [];
  // The universe the page was drawn from — active-only while browsing, every
  // store while searching. NOT `totalStores`, which is always the active count.
  const total = detail.storeTotal ?? detail.totalStores ?? 0;
  const matched = detail.storeMatched ?? rows.length;
  const page = detail.storePage ?? 1;
  const totalPages = detail.storeTotalPages ?? 1;
  // The server clamps the page into range (a search can shrink the result set
  // under the current page) — adopt what it actually served, don't keep asking
  // for a page that no longer exists.
  state.page = page;

  tbody.innerHTML = rows.length === 0
    ? `<tr><td colspan="5"><p class="muted text-[0.85rem] m-0 py-2">${state.q ? (i18n.perfStoresNoMatch ?? '') : (i18n.perfStoresEmpty ?? '')}</p></td></tr>`
    : rows.map(rowHtml).join('');

  setText('perf-stores-note', state.q ? fill('perfStoresMatched', { matched, total }) : fill('perfStoresTotal', { total }));
  setText('perf-stores-page-label', fill('perfStorePageOf', { page, pages: totalPages }));

  const pager = document.getElementById('perf-stores-pager');
  if (pager) {
    pager.hidden = totalPages <= 1;
    pager.querySelectorAll<HTMLButtonElement>('[data-store-page-step]').forEach((btn) => {
      const step = Number(btn.dataset.storePageStep);
      btn.disabled = step < 0 ? page <= 1 : page >= totalPages;
    });
  }
  syncHeaders();
}

/** The table's own params, pinned onto every range fetch too (performance.ts
 *  reads this back) so changing the date range preserves the current search/sort. */
function storeParams(): string {
  return `storeQ=${encodeURIComponent(state.q)}&storeSort=${state.sort}&storeDir=${state.dir}&storePage=${state.page}`
    + `&productQ=${encodeURIComponent(productQ)}`;
}

/** "Top 5 of 214 products" / "3 products match" — the line under the heading, which is where the
 *  list says what it is ranked by and how much of the period it is showing. */
function renderProductsNote(detail: LoadedDetail): void {
  if (!detail.summary) return;
  const matched = detail.productsMatched ?? detail.summary.topProducts.length;
  // Same rule as the SSR pass: with nothing sold there is no count worth stating next to a list
  // that already says the range is empty.
  setText('perf-products-note', productQ
    ? fill('perfTopProductsMatched', { matched })
    : matched === 0 ? '' : fill('perfTopProductsNote', { shown: detail.summary.topProducts.length, total: matched }));
}

/** The leading-products list after a fetch this module made. On a RANGE change the shared
 *  performance.ts has already redrawn the list from the same response, so that path only refreshes
 *  the note — redrawing it twice would replay the entrance animation over itself. */
function renderProducts(detail: LoadedDetail): void {
  const box = document.getElementById('perf-top-products');
  if (box && detail.summary) {
    renderTopProducts(box, detail.summary, i18n);
    // A filter is not an entrance. Two reasons to strip the grow animation off a searched result
    // rather than let it replay: it would restart on every debounced keystroke, and the container
    // may still be carrying `chart-hold` (performance.ts pauses the entrance until the list has
    // been scrolled to) — which would leave every bar paused at width 0, i.e. invisible. The final
    // width is on the element inline, so removing the class costs nothing but the growth.
    box.querySelectorAll('.animate-top-bar-grow').forEach((el) => el.classList.remove('animate-top-bar-grow'));
  }
  renderProductsNote(detail);
}

let inFlight = 0;
async function fetchTable(): Promise<void> {
  if (!picker) return;
  const endpoint = picker.dataset.endpoint || '/api/admin/platform-performance';
  const from = (document.getElementById('perf-from-input') as HTMLInputElement | null)?.value ?? '';
  const to = (document.getElementById('perf-to-input') as HTMLInputElement | null)?.value ?? '';
  if (!from || !to) return;
  picker.dataset.extraParams = storeParams();

  const wrap = document.getElementById('platform-store-table');
  // Typing is fast and the response is small — a spinner would flash more than
  // it informs. aria-busy keeps it announced without any visual jump.
  const token = ++inFlight;
  wrap?.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`${endpoint}?from=${from}&to=${to}&${storeParams()}`);
    if (!res.ok) { showActionFailedToast(); return; }
    const data = await res.json() as LoadedDetail;
    // A slower earlier request must not overwrite a newer one's rows.
    if (token !== inFlight) return;
    renderTable(data);
    renderProducts(data);
  } catch {
    // Keep the last-known rows — blanking the table would claim the search matched nothing — but
    // say so. This runs on a typed search and on a sort click, and a table that does not move
    // is otherwise indistinguishable from one that matched exactly what was already there.
    showActionFailedToast();
  }
  finally { if (token === inFlight) wrap?.removeAttribute('aria-busy'); }
}

// ── Money cards ──────────────────────────────────────────────────────────────

function updateSplitCard(summary: PerformanceSummary): void {
  setText('plat-gmv', fmtAgorot(summary.totalRevenueAgorot));
  setText('plat-commission', fmtAgorot(summary.platformCommissionAgorot));
  setText('plat-commission-rate', String(summary.commissionRate));
  setText('plat-payout', fmtAgorot(summary.netProfitAgorot));
}

function updateIncomeCard(revenue: PlatformRevenue): void {
  setText('plat-inc-commission', fmtAgorot(revenue.commissionAgorot));
  setText('plat-inc-commission-note', fill('perfIncomeCommissionNote', { rate: revenue.commissionRate }));
  setText('plat-inc-subscriptions', fmtAgorot(revenue.subscriptionsAgorot));
  setText('plat-inc-subs-note', fill('perfIncomeSubscriptionsNote', { count: revenue.subscribers }));
  setText('plat-inc-ad-margin', fmtAgorot(revenue.adMarginAgorot));
  setText('plat-inc-ad-note', fill('perfIncomeAdMarginNote', { rate: revenue.adMarginRate, spend: fmtAgorot(revenue.adSpendAgorot) }));
  setText('plat-inc-total', fmtAgorot(revenue.totalAgorot));
}

export function initAdminPlatformPerformance(): void {
  const table = document.getElementById('platform-store-table');
  if (!table) return;
  i18n = readI18n();
  picker = document.getElementById('perf-range-picker');

  // Seed from what the server already rendered, so the first sort/page click
  // continues that view instead of resetting it.
  const host = table.closest<HTMLElement>('[data-store-table-state]');
  try {
    if (host?.dataset.storeTableState) state = JSON.parse(host.dataset.storeTableState) as StoreRowsQuery;
  } catch { /* keep the defaults */ }
  if (picker) picker.dataset.extraParams = storeParams();
  syncHeaders();

  table.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.sortCol as StoreSortCol;
      if (col === state.sort) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      // Store name reads naturally A→Z; every numeric column reads best biggest-first.
      else { state.sort = col; state.dir = col === 'name' ? 'asc' : 'desc'; }
      state.page = 1;
      syncHeaders();
      void fetchTable();
    });
  });

  const search = document.getElementById('perf-stores-search') as HTMLInputElement | null;
  let debounce = 0;
  search?.addEventListener('input', () => {
    const q = search.value.trim();
    // A keystroke that doesn't change the effective query (leading/trailing
    // space) must not re-fetch or re-render — a no-op must stay invisible.
    if (q === state.q) return;
    state.q = q;
    state.page = 1;
    clearTimeout(debounce);
    debounce = window.setTimeout(() => void fetchTable(), SEARCH_DEBOUNCE_MS);
  });

  // Product search — the same fetch, because one response carries both halves. Ranking stays
  // revenue-desc, so a search is "the leading products whose name contains this", not a catalogue
  // lookup: the number beside each row still means share of the WHOLE period.
  const productSearch = document.getElementById('perf-products-search') as HTMLInputElement | null;
  let productDebounce = 0;
  productSearch?.addEventListener('input', () => {
    const q = productSearch.value.trim();
    if (q === productQ) return;
    productQ = q;
    // Set the moment the query changes, not at render time: on a range change the SHARED renderer
    // paints this list before this module is told anything, and it is the flag that decides whether
    // an empty box reads "nothing matched" or "nothing sold".
    const box = document.getElementById('perf-top-products');
    if (box) box.dataset.perfSearching = q ? '1' : '0';
    clearTimeout(productDebounce);
    productDebounce = window.setTimeout(() => void fetchTable(), SEARCH_DEBOUNCE_MS);
  });

  document.getElementById('perf-stores-pager')?.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('[data-store-page-step]');
    if (!btn || btn.disabled) return;
    state.page = Math.max(1, state.page + Number(btn.dataset.storePageStep));
    void fetchTable();
  });

  // Range picker (performance.ts) re-fetched → refresh the table + both cards
  // from that same response (it already carries our pinned store params).
  document.addEventListener('perf:loaded', (e) => {
    const detail = (e as CustomEvent<LoadedDetail>).detail;
    if (!detail) return;
    if (Array.isArray(detail.stores)) renderTable(detail);
    renderProductsNote(detail);
    if (detail.summary) updateSplitCard(detail.summary);
    if (detail.revenue) updateIncomeCard(detail.revenue);
  });
}
