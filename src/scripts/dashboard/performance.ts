import { formatPrice } from '../../config/store.config.js';
import { buildBarChartSvg } from '../../lib/chart-svg.js';
import type { PerformanceSummary } from '../../lib/seller-performance.js';

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

function toISODate(d: Date): string { return d.toISOString().slice(0, 10); }

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

export function initPerformanceTab(): void {
  const picker = document.getElementById('perf-range-picker');
  if (!picker) return;
  const storeSlug = picker.dataset.storeSlug ?? '';
  const fromInput = document.getElementById('perf-from-input') as HTMLInputElement | null;
  const toInput = document.getElementById('perf-to-input') as HTMLInputElement | null;
  const applyBtn = document.getElementById('perf-apply-btn');
  const presetBtns = picker.querySelectorAll<HTMLButtonElement>('.perf-preset-btn');
  const i18n = getI18n();

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

  presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetBtns.forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      const preset = btn.dataset.preset ?? '30d';
      const { from, to } = presetRange(preset);
      if (fromInput) fromInput.value = from;
      if (toInput) toInput.value = to;
      loadRange(from, to);
    });
  });

  applyBtn?.addEventListener('click', () => {
    const from = fromInput?.value;
    const to = toInput?.value;
    if (!from || !to || from > to) return;
    presetBtns.forEach((b) => b.setAttribute('aria-pressed', 'false'));
    loadRange(from, to);
  });
}
