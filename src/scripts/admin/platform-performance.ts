import { formatPrice } from '../../config/store.config.js';
import type { PerformanceSummary } from '../../lib/seller-performance.js';
import type { PlatformStoreRow } from '../../lib/platform-performance.js';

// Admin-only glue for the platform performance tab's per-store breakdown table
// and the GMV/commission split card. The charts + KPIs + top-products + range
// picker + revenue-breakdown donut are all driven by the SHARED performance.ts
// (via #perf-range-picker[data-endpoint]); this module only owns the two pieces
// that are platform-specific and have no equivalent on the seller tab. It stays
// in sync with the range picker by listening for the `perf:loaded` event
// performance.ts dispatches after every range fetch (detail = the full response).

type SortCol = 'revenue' | 'orders' | 'views' | 'conversionRate';
interface LoadedDetail {
  summary?: PerformanceSummary;
  stores?: PlatformStoreRow[];
  totalStores?: number;
  shownStores?: number;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let rows: PlatformStoreRow[] = [];
let sortCol: SortCol = 'revenue';
let sortDir: 'asc' | 'desc' = 'desc';
let i18n: Record<string, string> = {};

function readI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function rowHtml(s: PlatformStoreRow): string {
  const blocked = s.blocked ? ' <span class="admin-badge admin-badge--failed" style="margin-inline-start:0.4rem">חסום</span>' : '';
  return `<tr>
    <td><a href="/admin/store/${encodeURIComponent(s.slug)}/performance?from=performance" class="admin-link font-medium">${escHtml(s.name)}</a>${blocked}</td>
    <td>${escHtml(formatPrice(s.revenue))}</td>
    <td>${s.orders}</td>
    <td>${s.views}</td>
    <td>${s.conversionRate.toFixed(1)}%</td>
  </tr>`;
}

function renderRows(): void {
  const tbody = document.getElementById('platform-store-rows');
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><p class="muted text-[0.85rem] m-0 py-2">${i18n.perfStoresEmpty ?? ''}</p></td></tr>`;
    return;
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => (a[sortCol] < b[sortCol] ? -dir : a[sortCol] > b[sortCol] ? dir : 0));
  tbody.innerHTML = sorted.map(rowHtml).join('');
}

// Reflect the active sort on the header: aria-sort for a11y + a caret that
// shows only on the active column and points up (asc) / down (desc).
function syncHeaders(): void {
  document.querySelectorAll<HTMLButtonElement>('#platform-store-table [data-sort-col]').forEach((btn) => {
    const th = btn.closest('th');
    const caret = btn.querySelector<SVGElement>('.perf-sort-caret');
    const active = btn.dataset.sortCol === sortCol;
    if (th) th.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    if (caret) {
      caret.style.opacity = active ? '1' : '0';
      caret.style.transform = active && sortDir === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
    }
  });
}

function updateSplitCard(summary: PerformanceSummary): void {
  const gmv = document.getElementById('plat-gmv');
  const commission = document.getElementById('plat-commission');
  const rate = document.getElementById('plat-commission-rate');
  const payout = document.getElementById('plat-payout');
  if (gmv) gmv.textContent = formatPrice(summary.totalRevenue);
  if (commission) commission.textContent = formatPrice(summary.platformCommission);
  if (rate) rate.textContent = String(summary.commissionRate);
  if (payout) payout.textContent = formatPrice(summary.netProfit);
}

function updateNote(shown?: number, total?: number): void {
  const note = document.getElementById('perf-stores-note');
  if (!note || shown === undefined || total === undefined) return;
  note.textContent = total > shown ? (i18n.perfShowingTopStores ?? '').replace('{shown}', String(shown)).replace('{total}', String(total)) : '';
}

export function initAdminPlatformPerformance(): void {
  const table = document.getElementById('platform-store-table');
  if (!table) return;
  i18n = readI18n();

  try {
    const raw = document.getElementById('platform-stores-initial')?.textContent;
    if (raw) rows = JSON.parse(raw) as PlatformStoreRow[];
  } catch { rows = []; }

  syncHeaders();

  table.querySelectorAll<HTMLButtonElement>('[data-sort-col]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.sortCol as SortCol;
      if (col === sortCol) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = col; sortDir = 'desc'; }
      syncHeaders();
      renderRows();
    });
  });

  // Range picker (performance.ts) re-fetched → refresh the breakdown + split card.
  document.addEventListener('perf:loaded', (e) => {
    const detail = (e as CustomEvent<LoadedDetail>).detail;
    if (!detail) return;
    if (Array.isArray(detail.stores)) { rows = detail.stores; renderRows(); }
    if (detail.summary) updateSplitCard(detail.summary);
    updateNote(detail.shownStores, detail.totalStores);
  });
}
