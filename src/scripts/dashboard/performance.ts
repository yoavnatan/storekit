import { formatPrice } from '../../config/store.config.js';
import { buildBarChartSvg } from '../../lib/chart-svg.js';
import type { PerformanceSummary } from '../../lib/seller-performance.js';
import { showTooltip, hideTooltip, initInfoTooltips } from './tooltip.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const PRESETS = ['7d', '30d', '90d', 'thisMonth', 'lastMonth'] as const;
type Preset = typeof PRESETS[number];
const PRESET_LABEL_KEY: Record<Preset, string> = {
  '7d': 'perfPreset7d', '30d': 'perfPreset30d', '90d': 'perfPreset90d',
  thisMonth: 'perfPresetThisMonth', lastMonth: 'perfPresetLastMonth',
};

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function toISODate(d: Date): string { return d.toISOString().slice(0, 10); }
function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

function presetRange(preset: string): { from: string; to: string } {
  const today = new Date();
  const to = new Date(today);
  if (preset === '7d' || preset === '30d' || preset === '90d') {
    const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (preset === 'thisMonth') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (preset === 'lastMonth') {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: toISODate(from), to: toISODate(end) };
  }
  return { from: toISODate(to), to: toISODate(to) };
}

function renderTopProducts(container: HTMLElement, summary: PerformanceSummary, i18n: Record<string, string>): void {
  if (summary.topProducts.length === 0) {
    container.innerHTML = `<p class="muted text-[0.85rem] m-0">${i18n.perfTopProductsEmpty ?? ''}</p>`;
    return;
  }
  const maxRevenue = Math.max(...summary.topProducts.map((p) => p.revenue), 1);
  container.innerHTML = summary.topProducts.map((p) => {
    const pct = Math.round((p.revenue / maxRevenue) * 100);
    return `
      <div class="relative rounded-[var(--radius)] border [border-color:var(--color-border)] overflow-hidden">
        <div class="absolute inset-y-0 start-0 [background:color-mix(in_srgb,var(--color-primary)_12%,transparent)]" style="width:${pct}%"></div>
        <div class="relative flex items-center justify-between gap-3 py-2 px-3 text-[0.85rem]">
          <span class="font-medium overflow-hidden text-ellipsis whitespace-nowrap">${escHtml(p.name)}</span>
          <span class="shrink-0 [color:var(--color-muted)]">${p.units} ${i18n.perfUnitsSold ?? ''} · <strong class="[color:var(--color-text)]">${formatPrice(p.revenue)}</strong></span>
        </div>
      </div>`;
  }).join('');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSummary(summary: PerformanceSummary, i18n: Record<string, string>): void {
  const revenueEl = document.getElementById('perf-kpi-revenue');
  const ordersEl = document.getElementById('perf-kpi-orders');
  const avgEl = document.getElementById('perf-kpi-avg');
  const visitorsEl = document.getElementById('perf-kpi-visitors');
  const conversionEl = document.getElementById('perf-kpi-conversion');
  if (revenueEl) revenueEl.textContent = formatPrice(summary.totalRevenue);
  if (ordersEl) ordersEl.textContent = String(summary.totalOrders);
  if (avgEl) avgEl.textContent = formatPrice(summary.avgOrderValue);
  if (visitorsEl) visitorsEl.textContent = String(summary.totalViews);
  if (conversionEl) conversionEl.textContent = `${summary.conversionRate.toFixed(1)}%`;

  const revenueChart = document.getElementById('perf-revenue-chart');
  const visitorsChart = document.getElementById('perf-visitors-chart');
  if (revenueChart) {
    revenueChart.innerHTML = buildBarChartSvg(
      summary.points.map((p) => ({ label: p.label, value: p.revenue })),
      { color: 'var(--color-primary)', valueFormatter: formatPrice, emptyMessage: i18n.perfNoData }
    );
  }
  if (visitorsChart) {
    visitorsChart.innerHTML = buildBarChartSvg(
      summary.points.map((p) => ({ label: p.label, value: p.views })),
      { color: 'var(--color-accent)', valueFormatter: (v) => String(v), emptyMessage: i18n.perfNoData }
    );
  }

  const topProducts = document.getElementById('perf-top-products');
  if (topProducts) renderTopProducts(topProducts, summary, i18n);
}

// Delegated from the (persistent) chart container, not the individual
// <rect> bars — renderSummary() replaces the SVG's innerHTML wholesale on
// every range-picker fetch, which would otherwise silently drop any
// listener bound to a bar directly.
function initChartTooltips(): void {
  ['perf-revenue-chart', 'perf-visitors-chart'].forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.addEventListener('mouseover', (e) => {
      const bar = (e.target as Element).closest('.chart-bar');
      if (!bar) return;
      const label = bar.getAttribute('data-label') ?? '';
      const value = bar.getAttribute('data-value') ?? '';
      showTooltip(bar, `${label}: ${value}`);
    });
    container.addEventListener('mouseout', (e) => {
      if ((e.target as Element).closest('.chart-bar')) hideTooltip();
    });
  });
}

export function initPerformanceTab(): void {
  const picker = document.getElementById('perf-range-picker');
  if (!picker) return;
  initChartTooltips();
  initInfoTooltips();
  const storeSlug = picker.dataset.storeSlug ?? '';
  const fromInput = document.getElementById('perf-from-input') as HTMLInputElement | null;
  const toInput = document.getElementById('perf-to-input') as HTMLInputElement | null;
  const trigger = document.getElementById('perf-range-trigger');
  const label = document.getElementById('perf-range-label');
  const i18n = getI18n();
  // Range portal — presets + custom dates used to sit inline as five pills
  // plus two date inputs, always visible and eating a lot of horizontal
  // space above the charts (CURRENT_TASK.md). Now folded into one trigger +
  // the shared floating portal, same pattern as the orders tab's sort/filter
  // dropdowns (ordersPortal in dashboard.astro).
  const rangePortal = createFloatingPortal('perf-range-portal');

  let loading = false;
  async function loadRange(from: string, to: string): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch(`/api/seller/performance?storeSlug=${encodeURIComponent(storeSlug)}&from=${from}&to=${to}`);
      if (!res.ok) return;
      const data = await res.json() as { ok?: boolean; summary?: PerformanceSummary };
      if (data.summary) renderSummary(data.summary, i18n);
    } catch { /* keep last-known data on a transient network failure */ }
    finally { loading = false; }
  }

  function applyPreset(preset: Preset): void {
    picker!.dataset.activePreset = preset;
    const { from, to } = presetRange(preset);
    if (fromInput) fromInput.value = from;
    if (toInput) toInput.value = to;
    if (label) label.textContent = i18n[PRESET_LABEL_KEY[preset]] ?? preset;
    rangePortal.close();
    loadRange(from, to);
  }

  function applyCustomRange(from: string, to: string): void {
    if (!from || !to || from > to) return;
    delete picker!.dataset.activePreset;
    if (fromInput) fromInput.value = from;
    if (toInput) toInput.value = to;
    if (label) label.textContent = `${formatShortDate(from)}–${formatShortDate(to)}`;
    rangePortal.close();
    loadRange(from, to);
  }

  function buildPanelHtml(): string {
    const activePreset = picker!.dataset.activePreset ?? '';
    const presetsHtml = PRESETS.map((p) => `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-preset="${p}" style="${p === activePreset ? 'font-weight:700;color:var(--color-primary)' : ''}">${i18n[PRESET_LABEL_KEY[p]] ?? p}</button>`).join('');
    return `${presetsHtml}
      <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>
      <div class="flex items-center gap-1.5 px-3 py-2" dir="ltr">
        <input type="date" data-range-from value="${fromInput?.value ?? ''}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.6rem] outline-none w-full" />
        <span class="muted text-[0.8rem]">–</span>
        <input type="date" data-range-to value="${toInput?.value ?? ''}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.6rem] outline-none w-full" />
      </div>
      <button type="button" class="btn btn--sm btn--ghost" style="width:calc(100% - 1.5rem);margin:0 0.75rem" data-range-apply>${i18n.perfApply ?? 'Apply'}</button>`;
  }

  trigger?.addEventListener('click', () => {
    if (rangePortal.currentTrigger() === trigger) { rangePortal.close(); return; }
    rangePortal.open(trigger, '13rem', buildPanelHtml, (portal) => {
      portal.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => applyPreset((btn.dataset.preset as Preset) ?? '30d'));
      });
      portal.querySelector('[data-range-apply]')?.addEventListener('click', () => {
        const from = portal.querySelector<HTMLInputElement>('[data-range-from]')?.value ?? '';
        const to = portal.querySelector<HTMLInputElement>('[data-range-to]')?.value ?? '';
        applyCustomRange(from, to);
      });
    });
  });
}
