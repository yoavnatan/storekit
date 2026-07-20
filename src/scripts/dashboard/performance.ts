import { formatPrice } from '../../config/store.config.js';
import { buildBarChartSvg, buildLineChartSvg, buildMultiLineChartSvg, buildDonutChartSvg, type PieSlice } from '../../lib/chart-svg.js';
import type { PerformanceSummary, ProductPerformanceSummary } from '../../lib/seller-performance.js';
import { showTooltip, showTooltipAtPoint, hideTooltip, mountTooltipIn, initInfoTooltips } from './tooltip.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';

const PRESETS = ['today', 'thisWeek', 'thisMonth', 'lastMonth', '7d', '30d', '90d'] as const;
type Preset = typeof PRESETS[number];
const PRESET_LABEL_KEY: Record<Preset, string> = {
  today: 'perfPresetToday', thisWeek: 'perfPresetThisWeek',
  thisMonth: 'perfPresetThisMonth', lastMonth: 'perfPresetLastMonth',
  '7d': 'perfPreset7d', '30d': 'perfPreset30d', '90d': 'perfPreset90d',
};

// Donut palette — the site's two brand hues plus tints/success/warning, so a
// breakdown never repeats a colour across up to 6 slices while staying inside
// the platform's own palette (tokens.css). Order matters: the biggest slice
// (topProducts is revenue-sorted) gets the strongest brand colour first.
const DONUT_COLORS = [
  'var(--color-primary)',
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-warning)',
  'color-mix(in srgb, var(--color-accent) 55%, var(--color-surface))',
  'color-mix(in srgb, var(--color-primary) 45%, var(--color-surface))',
];

// Colours for n donut slices. Up to 6 products stay on the curated brand
// palette; beyond that (a store with many products in one period — the full
// breakdown can now list them all) the finite token palette would repeat a
// colour and merge adjacent slices, so we switch to an evenly-spaced categorical
// HSL scale where every slice is visibly distinct. Data-viz categorical colour
// is the one place a generated scale beats the fixed tokens.css palette.
function sliceColors(n: number): string[] {
  if (n <= DONUT_COLORS.length) return DONUT_COLORS.slice(0, n);
  return Array.from({ length: n }, (_, i) => `hsl(${Math.round((360 * i) / n)} 58% 56%)`);
}

function getI18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

// Local-calendar ISO (YYYY-MM-DD) — NOT toISOString(), which serialises in UTC
// and in a positive-UTC timezone (e.g. Israel) shifts a local-midnight date
// back to the previous day, so "this month" would start on the last day of the
// previous month. Range boundaries follow the seller's own calendar.
function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

function presetRange(preset: string): { from: string; to: string } {
  const today = new Date();
  const to = new Date(today);
  if (preset === 'today') {
    return { from: toISODate(today), to: toISODate(to) };
  }
  if (preset === 'thisWeek') {
    // Week starts on Sunday (Israeli convention). getDay(): 0=Sun … 6=Sat.
    const from = new Date(today);
    from.setDate(from.getDate() - today.getDay());
    return { from: toISODate(from), to: toISODate(to) };
  }
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
  const totalRevenue = Math.max(summary.topProducts.reduce((s, p) => s + p.revenue, 0), 1);
  container.innerHTML = summary.topProducts.map((p, i) => {
    const pct = Math.round((p.revenue / totalRevenue) * 100);
    return `
      <div class="relative rounded-[var(--radius)] border [border-color:var(--color-border)] overflow-hidden">
        <div class="absolute inset-y-0 start-0 [background:color-mix(in_srgb,var(--color-primary)_12%,transparent)] animate-top-bar-grow" style="width:${pct}%;--tw:${pct}%;animation-delay:${Math.min(i * 60, 300)}ms"></div>
        <div class="relative flex items-center justify-between gap-3 py-2 px-3 text-[0.85rem]">
          <span class="font-medium overflow-hidden text-ellipsis whitespace-nowrap">${escHtml(p.name)}</span>
          <span class="shrink-0 [color:var(--color-muted)]"><strong class="[color:var(--color-text)]">${pct}%</strong> · ${p.units} ${i18n.perfUnitsSold ?? ''} · ${formatPrice(p.revenue)}</span>
        </div>
      </div>`;
  }).join('');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Last rendered summary + direction, kept so the charts can be re-painted at a
// new container width (ResizeObserver / tab becomes visible) without re-fetching.
let lastSummary: PerformanceSummary | null = null;
let chartRtl = false;
let lastChartWidth = 0;

// The container's real pixel width → passed as the SVG viewBox width so it
// renders 1:1 (viewBox px === CSS px) and the axis text is exact, never a
// downscaled 640-unit chart squeezed into a narrower 2-column card. 0 while the
// panel is still display:none (nothing to measure yet).
function chartPixelWidth(): number {
  const w = document.getElementById('perf-revenue-chart')?.clientWidth ?? 0;
  return w > 0 ? Math.round(w) : 640;
}

// `animate` is true only for a genuine data change (range-picker fetch). A
// resize-driven repaint (ResizeObserver) passes false: it re-renders solely to
// match the new container width, so replaying the bar-grow / line-draw entrance
// every time the window is dragged would be visual noise (CURRENT_TASK.md — the
// chart must sit still, not re-animate on resize).
function paintCharts(summary: PerformanceSummary, i18n: Record<string, string>, animate = false): void {
  const width = chartPixelWidth();
  lastChartWidth = width;
  const revenueChart = document.getElementById('perf-revenue-chart');
  const visitorsChart = document.getElementById('perf-visitors-chart');
  if (revenueChart) {
    revenueChart.innerHTML = buildBarChartSvg(
      summary.points.map((p) => ({ label: p.label, value: p.revenue, key: p.key })),
      { width, color: 'var(--color-primary)', valueFormatter: formatPrice, emptyMessage: i18n.perfNoData, rtl: chartRtl, animate }
    );
  }
  if (visitorsChart) {
    visitorsChart.innerHTML = buildMultiLineChartSvg(
      [
        // Primary: unique visitors (solid accent + area). Secondary: total visits
        // (dashed muted envelope above it). The gap between them = returning traffic.
        { points: summary.points.map((p) => ({ label: p.label, value: p.uniqueVisitors })), color: 'var(--color-accent)', fill: true, label: i18n.perfUniqueVisitors },
        { points: summary.points.map((p) => ({ label: p.label, value: p.views })), color: 'var(--color-muted)', dashed: true, label: i18n.perfVisitors },
      ],
      { width, valueFormatter: (v) => String(v), emptyMessage: i18n.perfNoData, rtl: chartRtl, animate }
    );
  }
}

function renderSummary(summary: PerformanceSummary, i18n: Record<string, string>): void {
  lastSummary = summary;
  const revenueEl = document.getElementById('perf-kpi-revenue');
  const ordersEl = document.getElementById('perf-kpi-orders');
  const avgEl = document.getElementById('perf-kpi-avg');
  const visitorsEl = document.getElementById('perf-kpi-visitors');
  const uniqueEl = document.getElementById('perf-kpi-unique');
  const conversionEl = document.getElementById('perf-kpi-conversion');
  if (revenueEl) revenueEl.textContent = formatPrice(summary.totalRevenue);
  if (ordersEl) ordersEl.textContent = String(summary.totalOrders);
  if (avgEl) avgEl.textContent = formatPrice(summary.avgOrderValue);
  if (visitorsEl) visitorsEl.textContent = String(summary.totalViews);
  if (uniqueEl) uniqueEl.textContent = String(summary.totalUniqueVisitors);
  if (conversionEl) conversionEl.textContent = `${summary.conversionRate.toFixed(1)}%`;

  // Profitability breakdown (gross → −commission → net).
  const grossEl = document.getElementById('perf-gross');
  const commissionEl = document.getElementById('perf-commission');
  const commissionRateEl = document.getElementById('perf-commission-rate');
  const netEl = document.getElementById('perf-net');
  if (grossEl) grossEl.textContent = formatPrice(summary.totalRevenue);
  if (commissionEl) commissionEl.textContent = `−${formatPrice(summary.platformCommission)}`;
  if (commissionRateEl) commissionRateEl.textContent = String(summary.commissionRate);
  if (netEl) netEl.textContent = formatPrice(summary.netProfit);

  paintCharts(summary, i18n, true);

  const topProducts = document.getElementById('perf-top-products');
  if (topProducts) renderTopProducts(topProducts, summary, i18n);
}

// Delegated from the (persistent) chart container, not the individual
// <rect> bars — renderSummary() replaces the SVG's innerHTML wholesale on
// every range-picker fetch, which would otherwise silently drop any
// listener bound to a bar directly.
function initChartTooltips(): void {
  ['perf-revenue-chart', 'perf-visitors-chart', 'pperf-revenue-chart', 'pperf-views-chart'].forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    // Tint the visits (line) tooltips to the chart's own accent colour; the
    // revenue (bar) charts keep the default dark tooltip.
    const tipColor = id === 'perf-visitors-chart' || id === 'pperf-views-chart' ? 'var(--color-accent)' : undefined;
    // The point currently being explained on a line chart, so the tooltip is
    // re-positioned only when you cross to a *different* point — not on every
    // mousemove within the same column (which would flicker showTooltip's fade,
    // and would drift the tooltip off the point).
    let activeDot: Element | null = null;
    const show = (e: MouseEvent): void => {
      const target = e.target as Element;
      // Line chart: the visible dot sits ON TOP of a full-height hit rect, both
      // inside one .chart-point group. Hovering the dot must still register —
      // it's a sibling of the .chart-bar rect, so closest('.chart-bar') from the
      // dot would miss and blank the tooltip (the reported bug). Anchor to the
      // dot itself (showTooltip → just above the point), independent of where in
      // the column the cursor sits.
      const group = target.closest('.chart-point');
      if (group) {
        const bar = group.querySelector('.chart-bar');
        const dot = group.querySelector('.line-dot');
        if (bar && dot) {
          if (dot !== activeDot) {
            activeDot = dot;
            showTooltip(dot, `${bar.getAttribute('data-label') ?? ''}: ${bar.getAttribute('data-value') ?? ''}`, tipColor);
          }
          return;
        }
      }
      // Bar chart: no .chart-point group; bars are wide, so cursor-anchoring
      // reads naturally and never flickers (showTooltipAtPoint doesn't refade).
      activeDot = null;
      const bar = target.closest('.chart-bar');
      if (!bar) { hideTooltip(); return; }
      showTooltipAtPoint(e.clientX, e.clientY, `${bar.getAttribute('data-label') ?? ''}: ${bar.getAttribute('data-value') ?? ''}`);
    };
    container.addEventListener('mouseover', show);
    container.addEventListener('mousemove', show);
    container.addEventListener('mouseleave', () => { activeDot = null; hideTooltip(); });
  });
}

// Maps a clicked revenue bar's period key back to a fetchable date range:
// a 'YYYY-MM-DD' key is a single day; a 'YYYY-MM' key is a whole month.
function bucketRange(key: string): { from: string; to: string } {
  if (key.length === 7) {
    const [y, m] = key.split('-').map(Number);
    const from = `${key}-01`;
    // Date.UTC (not a local Date) so toISOString below doesn't shift the last
    // day back to the previous one in positive-UTC timezones — the summary's
    // own month buckets are UTC, and `to` must match. Day 0 of next month =
    // last day of this one.
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from, to };
  }
  return { from: key, to: key };
}

// Revenue-breakdown modal: given a clicked bar's period, fetch that period's
// own product breakdown (reusing /api/seller/performance — its topProducts is
// exactly the per-range composition we want) and render a donut + legend.
function initBreakdownModal(storeSlug: string, endpoint: string, i18n: Record<string, string>): (key: string, label: string) => void {
  const modal = document.getElementById('perf-breakdown-modal') as HTMLDialogElement | null;
  const body = document.getElementById('perf-breakdown-body');
  const subtitle = document.getElementById('pbm-subtitle');
  const closeBtn = document.getElementById('perf-breakdown-close');
  if (!modal || !body) return () => {};

  const close = (): void => { if (modal.open) modal.close(); };
  closeBtn?.addEventListener('click', close);
  // Click on the backdrop (the dialog element itself, outside its content) closes.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  // The shared tooltip must sit inside the dialog (top layer) while it's open,
  // else it paints behind the modal; restore it to <body> on close.
  modal.addEventListener('close', () => { hideTooltip(); mountTooltipIn(document.body); });

  // Donut slice hover → cursor-anchored tooltip naming the product + its share.
  // Delegated from the persistent body since renderSlices() replaces its
  // innerHTML on every open. Positioned at the pointer (not the <circle> bbox,
  // which is the whole ring for every slice).
  const segTip = (seg: Element, e: MouseEvent): void => {
    const name = seg.getAttribute('data-label') ?? '';
    const pct = seg.getAttribute('data-pct') ?? '0';
    const amount = Number(seg.getAttribute('data-amount') ?? '0');
    showTooltipAtPoint(e.clientX, e.clientY, `${name}: ${pct}% · ${formatPrice(amount)}`);
  };
  body.addEventListener('mouseover', (e) => {
    const seg = (e.target as Element).closest('.donut-seg');
    if (seg) segTip(seg, e as MouseEvent);
  });
  body.addEventListener('mousemove', (e) => {
    const seg = (e.target as Element).closest('.donut-seg');
    if (seg) segTip(seg, e as MouseEvent);
  });
  body.addEventListener('mouseout', (e) => {
    if ((e.target as Element).closest('.donut-seg')) hideTooltip();
  });

  const msg = (text: string): string => `<p class="muted text-center text-[0.85rem] m-0 py-8">${text}</p>`;

  // Legend rows also carry units sold — the donut only encodes revenue share, so
  // the quantity behind each slice (e.g. many cheap units vs. one pricey one) is
  // otherwise invisible. Kept on its own muted subline so the name still gets the
  // full row width to truncate in on a narrow (mobile) modal.
  function renderSlices(slices: Array<PieSlice & { units: number }>, total: number): string {
    const donut = buildDonutChartSvg(slices, { size: 168 });
    const legend = slices.map((s) => {
      const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
      return `<li class="flex items-center gap-2 text-[0.83rem] py-1.5">
        <span class="inline-block w-3 h-3 rounded-[3px] shrink-0" style="background:${s.color}"></span>
        <span class="flex-1 min-w-0">
          <span class="block overflow-hidden text-ellipsis whitespace-nowrap">${escHtml(s.label)}</span>
          <span class="block text-[0.72rem] [color:var(--color-muted)]">${s.units} ${i18n.perfUnitsSold ?? ''}</span>
        </span>
        <span class="shrink-0 [color:var(--color-muted)]">${pct}% · <strong class="[color:var(--color-text)] font-semibold">${formatPrice(s.value)}</strong></span>
      </li>`;
    }).join('');
    // Legend scrolls within the modal (max-h + overflow) rather than growing the
    // dialog off-screen — a safety net if the summary's top-N cap (currently 5,
    // seller-performance.ts) is ever raised; today it never fills this height.
    return `<div class="flex justify-center mb-3">${donut}</div><ul class="list-none m-0 p-0 flex flex-col max-h-[40vh] overflow-y-auto [&>li+li]:border-t [&>li+li]:[border-color:var(--color-border)]">${legend}</ul>`;
  }

  return async function open(key: string, label: string): Promise<void> {
    if (subtitle) subtitle.textContent = label;
    // Open with an empty (min-height) body, not a loading state — on a fast
    // local response the loading text would flash for a few ms before the donut
    // replaced it (the flicker). Only paint "loading" if still pending at 180ms.
    body!.innerHTML = '';
    if (!modal!.open) { modal!.showModal(); mountTooltipIn(modal!); }
    const loadingTimer = window.setTimeout(() => { body!.innerHTML = msg(i18n.perfLoading ?? ''); }, 180);
    const paint = (html: string): void => { clearTimeout(loadingTimer); body!.innerHTML = html; };
    const { from, to } = bucketRange(key);
    try {
      const res = await fetch(`${endpoint}?storeSlug=${encodeURIComponent(storeSlug)}&from=${from}&to=${to}&products=all`);
      if (!res.ok) { paint(msg(i18n.perfBreakdownEmpty ?? '')); return; }
      const data = await res.json() as { summary?: PerformanceSummary };
      const s = data.summary;
      const tops = s?.topProducts ?? [];
      if (!s || tops.length === 0) { paint(msg(i18n.perfBreakdownEmpty ?? '')); return; }
      // Composition is built purely from topProducts' own (gross) revenue and
      // percentages are relative to their sum — no "Other" slice: the summary
      // only exposes a *net* totalRevenue (discount-adjusted), so subtracting a
      // gross top-5 sum from it to synthesise a remainder would mix two bases
      // and could go negative. This is honestly a "top products share" donut.
      const colors = sliceColors(tops.length);
      const slices = tops.map((p, i) => ({ label: p.name, value: p.revenue, color: colors[i], units: p.units }));
      const total = slices.reduce((a, b) => a + b.value, 0);
      paint(renderSlices(slices, total));
    } catch {
      paint(msg(i18n.perfBreakdownEmpty ?? ''));
    }
  };
}

export function initPerformanceTab(): void {
  const picker = document.getElementById('perf-range-picker');
  if (!picker) return;
  initChartTooltips();
  initInfoTooltips();
  const storeSlug = picker.dataset.storeSlug ?? '';
  // Endpoint is overridable so the same charting/range/donut logic backs both
  // the seller dashboard (its own session-scoped store) and the admin per-store
  // performance page (/admin/store/[slug]/performance, admin-guarded, any store).
  // Defaults to the seller route so existing markup that omits it is unchanged.
  const endpoint = picker.dataset.endpoint || '/api/seller/performance';
  const fromInput = document.getElementById('perf-from-input') as HTMLInputElement | null;
  const toInput = document.getElementById('perf-to-input') as HTMLInputElement | null;
  const trigger = document.getElementById('perf-range-trigger');
  const label = document.getElementById('perf-range-label');
  const i18n = getI18n();

  // Direction for the y-axis side (right in Hebrew). Read from the charts grid's
  // data attribute (server-rendered from the request lang), fall back to <html>.
  const grid = document.querySelector<HTMLElement>('[data-perf-rtl]');
  chartRtl = grid?.dataset.perfRtl === '1' || document.documentElement.dir === 'rtl';

  // Seed lastSummary from the SSR-embedded blob so a resize / tab-reveal can
  // re-paint the charts at the real container width without a fetch.
  try {
    const raw = document.getElementById('perf-initial-summary')?.textContent;
    if (raw) lastSummary = JSON.parse(raw) as PerformanceSummary;
  } catch { /* leave null — first range fetch will populate it */ }

  // ── Per-product drill-down (סשן א׳) ──────────────────────────────────────
  // A searchable product picker (the shared floating portal, so it's the same
  // site-design dropdown as the range picker and stays pinned on scroll) drives
  // a fetch to the same endpoint with &productId=…, rendering that one product's
  // sales + page-views over the tab's current range. It reuses #perf-range-picker's
  // storeSlug/endpoint and the from/to inputs, so it always follows the range.
  let productList: Array<{ id: string; name: string }> = [];
  try { productList = JSON.parse(document.getElementById('perf-product-list')?.textContent ?? '[]') as Array<{ id: string; name: string }>; } catch { /* none */ }
  // Alphabetical (Hebrew-aware) so the picker is scannable, not in raw store order.
  productList.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  const productPortal = createFloatingPortal('perf-product-portal');
  const productTrigger = document.getElementById('perf-product-trigger');
  const productLabelEl = document.getElementById('perf-product-label');
  const productEmpty = document.getElementById('perf-product-empty');
  const productResult = document.getElementById('perf-product-result');
  let selectedProductId = '';
  let lastProductSummary: ProductPerformanceSummary | null = null;

  function pProdWidth(id: string): number {
    const w = document.getElementById(id)?.clientWidth ?? 0;
    return w > 0 ? Math.round(w) : 320;
  }

  function paintProductCharts(ps: ProductPerformanceSummary, animate = false): void {
    const revEl = document.getElementById('pperf-revenue-chart');
    const viewsEl = document.getElementById('pperf-views-chart');
    if (revEl) {
      revEl.innerHTML = buildBarChartSvg(
        ps.points.map((p) => ({ label: p.label, value: p.revenue, key: p.key })),
        { width: pProdWidth('pperf-revenue-chart'), color: 'var(--color-primary)', valueFormatter: formatPrice, emptyMessage: i18n.perfNoData, rtl: chartRtl, animate },
      );
    }
    if (viewsEl) {
      viewsEl.innerHTML = buildLineChartSvg(
        ps.points.map((p) => ({ label: p.label, value: p.views })),
        { width: pProdWidth('pperf-views-chart'), color: 'var(--color-accent)', valueFormatter: (v) => String(v), emptyMessage: i18n.perfNoData, rtl: chartRtl, animate },
      );
    }
  }

  function renderProductSummary(ps: ProductPerformanceSummary): void {
    lastProductSummary = ps;
    const set = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    set('pperf-kpi-views', String(ps.totalViews));
    set('pperf-kpi-units', String(ps.totalUnits));
    set('pperf-kpi-revenue', formatPrice(ps.totalRevenue));
    set('pperf-kpi-conversion', `${ps.conversionRate.toFixed(1)}%`);
    if (productEmpty) productEmpty.hidden = true;
    if (productResult) productResult.hidden = false;
    paintProductCharts(ps, true);
  }

  async function loadProduct(): Promise<void> {
    if (!selectedProductId) return;
    const from = fromInput?.value ?? '';
    const to = toInput?.value ?? '';
    try {
      const res = await fetch(`${endpoint}?storeSlug=${encodeURIComponent(storeSlug)}&from=${from}&to=${to}&productId=${encodeURIComponent(selectedProductId)}`);
      if (!res.ok) return;
      const data = await res.json() as { ok?: boolean; product?: ProductPerformanceSummary };
      if (data.product) renderProductSummary(data.product);
    } catch { /* keep last-known product data on a transient failure */ }
  }
  function refreshSelectedProduct(): void { if (selectedProductId) void loadProduct(); }

  function buildProductMenu(): string {
    // A "clear" row at the top deselects any product and collapses the section
    // back to its empty state (data-product-id="" → selectProduct('')).
    const clear = `<button type="button" role="option" aria-selected="${!selectedProductId}" data-product-id="" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] [color:var(--color-muted)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" style="${!selectedProductId ? 'font-weight:700' : ''}">${escHtml(i18n.perfProductClear ?? '')}</button>
      <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`;
    const options = productList.map((p) => {
      const selected = p.id === selectedProductId;
      return `<button type="button" role="option" aria-selected="${selected}" data-product-id="${escHtml(p.id)}" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${escHtml(p.name)}</button>`;
    }).join('');
    // The wrapper bleeds over the portal's own 0.3rem padding on all sides
    // (negative margins, padding restored inside) and its sticky `top` is pulled
    // up by that same 0.3rem so it stays flush to the portal's TOP edge while
    // scrolling — otherwise the 0.3rem padding strip above `top:0` is left
    // uncovered and a row scrolling up peeks through it (the reported bug). Solid
    // surface background + bottom border so the list is fully hidden underneath.
    return `<div class="sticky top-[-0.3rem] z-10 [background:var(--color-surface)] -mx-[.3rem] -mt-[.3rem] px-[.3rem] pt-[.3rem] pb-[.4rem] mb-1 border-b [border-color:var(--color-border)]"><input type="search" data-product-search placeholder="${escHtml(i18n.perfProductSearch ?? '')}" class="w-full font-[inherit] text-[.82rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.35rem] px-[.7rem] outline-none" /></div>
      ${clear}
      <div data-product-options>${options}</div>
      <p data-product-nomatch class="muted text-[0.82rem] m-0 px-3 py-2 text-center" hidden>${escHtml(i18n.perfProductNoMatch ?? '')}</p>`;
  }

  function selectProduct(id: string, name: string): void {
    selectedProductId = id;
    productPortal.close();
    // Empty id = the "clear" row: collapse the section back to its empty state.
    if (!id) {
      if (productLabelEl) productLabelEl.textContent = i18n.perfProductPick ?? '';
      lastProductSummary = null;
      if (productResult) productResult.hidden = true;
      if (productEmpty) productEmpty.hidden = false;
      return;
    }
    if (productLabelEl) productLabelEl.textContent = name;
    void loadProduct();
  }

  function wireProductMenu(portal: HTMLElement): void {
    const searchInput = portal.querySelector<HTMLInputElement>('[data-product-search]');
    const noMatch = portal.querySelector<HTMLElement>('[data-product-nomatch]');
    const buttons = [...portal.querySelectorAll<HTMLButtonElement>('[data-product-id]')];
    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      let any = false;
      buttons.forEach((b) => { const m = (b.textContent ?? '').toLowerCase().includes(q); b.hidden = !m; if (m) any = true; });
      if (noMatch) noMatch.hidden = any;
    });
    portal.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-product-id]');
      if (b) selectProduct(b.dataset.productId ?? '', b.textContent ?? '');
    });
    searchInput?.focus();
  }

  productTrigger?.addEventListener('click', () => {
    if (productList.length === 0) return;
    if (productPortal.currentTrigger() === productTrigger) { productPortal.close(); return; }
    productPortal.open(productTrigger, '16rem', buildProductMenu, wireProductMenu);
  });

  // Re-paint at the container's true pixel width once it's measurable (the panel
  // may be display:none at load) and whenever it changes. The SSR charts use a
  // fixed 640-unit viewBox that gets downscaled into a narrow 2-column card,
  // shrinking the axis text; rendering at the measured width keeps it crisp.
  const revChart = document.getElementById('perf-revenue-chart');
  if (revChart && 'ResizeObserver' in window) {
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const w = chartPixelWidth();
        if (lastSummary && w > 0 && w !== lastChartWidth) paintCharts(lastSummary, i18n);
        // Repaint the per-product charts too (if a product is showing) so they
        // stay crisp at the new width — no re-fetch, same as the store charts.
        if (lastProductSummary) paintProductCharts(lastProductSummary, false);
      });
    });
    ro.observe(revChart);
  }

  // Revenue bars carry a data-key (their day/month bucket) — clicking one opens
  // the product-composition donut for that period. Delegated from the
  // persistent container since renderSummary() replaces the SVG wholesale.
  const openBreakdown = initBreakdownModal(storeSlug, endpoint, i18n);
  document.getElementById('perf-revenue-chart')?.addEventListener('click', (e) => {
    const bar = (e.target as Element).closest('.chart-bar');
    const key = bar?.getAttribute('data-key');
    if (key) openBreakdown(key, bar!.getAttribute('data-label') ?? '');
  });
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
      const res = await fetch(`${endpoint}?storeSlug=${encodeURIComponent(storeSlug)}&from=${from}&to=${to}`);
      if (!res.ok) return;
      const data = await res.json() as { ok?: boolean; summary?: PerformanceSummary };
      if (data.summary) renderSummary(data.summary, i18n);
      // Let a surrounding page augment the same fetch with its own extra data
      // (the admin platform tab's per-store breakdown + GMV split card read
      // `stores`/`totalStores` off this response). Harmless where unlistened.
      document.dispatchEvent(new CustomEvent('perf:loaded', { detail: data }));
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
    refreshSelectedProduct();
  }

  function applyCustomRange(from: string, to: string): void {
    if (!from || !to || from > to) return;
    delete picker!.dataset.activePreset;
    if (fromInput) fromInput.value = from;
    if (toInput) toInput.value = to;
    if (label) label.textContent = `${formatShortDate(from)}–${formatShortDate(to)}`;
    rangePortal.close();
    loadRange(from, to);
    refreshSelectedProduct();
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
