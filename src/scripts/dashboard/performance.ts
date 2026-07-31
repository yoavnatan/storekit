import { formatPrice } from '../../config/store.config.js';
import { escapeHtml as escHtml } from '../../lib/html-escape.js';
import { buildBarChartSvg, buildLineChartSvg, buildMultiLineChartSvg, buildDonutChartSvg, type PieSlice } from '../../lib/chart-svg.js';
import type { PerformanceSummary, ProductPerformanceSummary } from '../../lib/seller-performance.js';
import { showTooltip, showTooltipAtPoint, hideTooltip, mountTooltipIn, initInfoTooltips } from '../tooltip.js';
import { createFloatingPortal } from '../../lib/toolbar-portal.js';
import { showErrorToast } from '../../lib/toast.js';
import { businessDayISO, businessMonthStartISO, calendarDayISO, BUSINESS_TIMEZONE } from '../../lib/business-day.js';
import { addDaysISO } from '../../lib/date-range.js';

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

function formatShortDate(iso: string): string {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', timeZone: BUSINESS_TIMEZONE });
}

/**
 * Every bound is derived from the BUSINESS day (business-day.ts) by calendar
 * arithmetic on the date string — never from the browser's own clock.
 *
 * This used to build each bound from a local `Date`, which is the SELLER'S DEVICE
 * timezone. On a laptop still set to another zone (or simply travelling), "this
 * month" was computed against one calendar while the server bucketed the orders
 * against another, and the range silently included or dropped a day at each end.
 * Deriving everything from one `today` string removes the possibility rather than
 * making the two agree by luck.
 */
function presetRange(preset: string): { from: string; to: string } {
  const to = businessDayISO(new Date());
  if (preset === 'today') return { from: to, to };
  if (preset === 'thisWeek') {
    // Week starts on Sunday (Israeli convention). getUTCDay() on the parsed calendar
    // date — a pure date string has no zone, so this is the weekday of `to` itself.
    const weekday = new Date(to + 'T00:00:00Z').getUTCDay();
    return { from: addDaysISO(to, -weekday), to };
  }
  if (preset === '7d' || preset === '30d' || preset === '90d') {
    const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
    return { from: addDaysISO(to, -(days - 1)), to };
  }
  if (preset === 'thisMonth') return { from: businessMonthStartISO(to), to };
  if (preset === 'lastMonth') {
    // Day before this month's 1st = last day of the previous month.
    const end = addDaysISO(businessMonthStartISO(to), -1);
    return { from: businessMonthStartISO(end), to: end };
  }
  return { from: to, to };
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

// Last rendered summary + direction, kept so the charts can be re-painted at a
// new container width (ResizeObserver / tab becomes visible) without re-fetching.
let lastSummary: PerformanceSummary | null = null;
let chartRtl = false;
let lastChartWidth = 0;

// The container's real pixel width → passed as the SVG viewBox width so it
// renders 1:1 (viewBox px === CSS px) and the axis text is exact, never a
// downscaled 640-unit chart squeezed into a narrower 2-column card. 0 while the
// panel is still display:none (nothing to measure yet).
// Measured PER CHART, not once for all of them: the visits chart spans the full grid row while
// revenue and orders are half-width, so one shared number would render its SVG at half size and
// let the browser stretch it — the blurry axis text this measurement exists to avoid.
function chartPixelWidth(id = 'perf-revenue-chart'): number {
  const w = document.getElementById(id)?.clientWidth ?? 0;
  return w > 0 ? Math.round(w) : 640;
}

// Entrance animations are ARMED by a paint, not fired by it.
//
// Two things go wrong when a paint plays the animation immediately. A refresh restores
// the seller's scroll position, so the panel is routinely laid out with half its charts
// below the fold — those spent their entrance where nobody was looking, and scrolling
// down reached a chart that was simply already there. And a CSS animation RESTARTS every
// time its element goes display:none → visible, which is exactly what the tab strip does
// to this panel: leaving the tab and coming back replayed the entrance, but only for the
// charts whose last paint happened to carry the classes — the "sometimes it animates,
// sometimes it doesn't" (owner, 2026-07-31).
//
// So: hold the animation at its first frame (.chart-hold, tokens.css), release it when
// the element actually reaches the viewport, and strip the animation classes once they
// have played. The DOM at rest then carries no animation at all, and there is nothing
// left for a display flip to restart.
function armEntrance(container: HTMLElement | null): void {
  if (!container || container.querySelector('.animate-bar-grow, .animate-line-draw, .animate-top-bar-grow') === null) return;

  // One listener per container, not per paint — the container survives every repaint.
  if (!container.dataset.entranceWired) {
    container.dataset.entranceWired = '1';
    container.addEventListener('animationend', (e) => {
      (e.target as Element).classList.remove('animate-bar-grow', 'animate-line-draw', 'animate-top-bar-grow');
    });
  }

  const release = () => container.classList.remove('chart-hold');
  if (!('IntersectionObserver' in window)) { release(); return; }
  container.classList.add('chart-hold');
  // Added synchronously in the same task as the innerHTML write, so no frame escapes
  // un-held. threshold 0.15: a chart counts as seen once a sliver of it is, not only
  // when the whole 200px box has cleared the fold.
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((en) => en.isIntersecting)) return;
    io.disconnect();
    release();
  }, { threshold: 0.15 });
  io.observe(container);
}

// The server renders its charts deliberately STATIC (animate:false — dashboard.astro
// and the two admin performance surfaces), because they get replaced within a frame or
// two by this module's first paint at the real measured width. The entrance therefore
// belongs to whichever paint first lands at that width: animating on the server meant
// the swap either froze it partway or, once deferred until it finished, moved the whole
// chart's geometry the instant it ended — a visible jump at the worst possible moment.
// Every LATER repaint is a resize and must not replay it.
let paintedOnce = false;

// `animate` is true only for a genuine data change (range-picker fetch). A
// resize-driven repaint (ResizeObserver) passes false: it re-renders solely to
// match the new container width, so replaying the bar-grow / line-draw entrance
// every time the window is dragged would be visual noise (CURRENT_TASK.md — the
// chart must sit still, not re-animate on resize).
function paintCharts(summary: PerformanceSummary, i18n: Record<string, string>, animate = false): void {
  const width = chartPixelWidth();
  lastChartWidth = width;
  paintedOnce = true;
  const revenueChart = document.getElementById('perf-revenue-chart');
  const ordersChart = document.getElementById('perf-orders-chart');
  const visitorsChart = document.getElementById('perf-visitors-chart');
  if (revenueChart) {
    revenueChart.innerHTML = buildBarChartSvg(
      summary.points.map((p) => ({ label: p.label, value: p.revenue, key: p.key })),
      { width, color: 'var(--color-primary)', valueFormatter: formatPrice, emptyMessage: i18n.perfNoData, rtl: chartRtl, animate }
    );
    armEntrance(revenueChart);
  }
  // Orders per bucket — same axis as the revenue bars, the other unit (see dashboard.astro's
  // perfOrdersChartSvg for why it is a line and why it shares the revenue accent). Absent on the
  // admin surfaces, which render only the two original charts.
  if (ordersChart) {
    ordersChart.innerHTML = buildLineChartSvg(
      summary.points.map((p) => ({ label: p.label, value: p.orders })),
      { width: chartPixelWidth('perf-orders-chart'), color: 'var(--color-primary)', valueFormatter: (v) => String(v), emptyMessage: i18n.perfNoData, rtl: chartRtl, animate }
    );
    armEntrance(ordersChart);
  }
  if (visitorsChart) {
    visitorsChart.innerHTML = buildMultiLineChartSvg(
      [
        // Primary: unique visitors (solid accent + area). Secondary: total visits
        // (dashed muted envelope above it). The gap between them = returning traffic.
        { points: summary.points.map((p) => ({ label: p.label, value: p.uniqueVisitors })), color: 'var(--color-accent)', fill: true, label: i18n.perfUniqueVisitors },
        { points: summary.points.map((p) => ({ label: p.label, value: p.views })), color: 'var(--color-muted)', dashed: true, label: i18n.perfVisitors },
      ],
      { width: chartPixelWidth('perf-visitors-chart'), valueFormatter: (v) => String(v), emptyMessage: i18n.perfNoData, rtl: chartRtl, animate }
    );
    armEntrance(visitorsChart);
  }
}

/**
 * Blank every figure in the panel back to its placeholder while a new range is
 * being fetched.
 *
 * Each element carries its own placeholder geometry in `data-skel` (set once in
 * dashboard.astro's SKEL map, which the server-rendered placeholders use too) —
 * so the bar that stands in for a price is price-shaped and the one standing in
 * for a chart is chart-shaped, and nothing jumps when the real value lands. A
 * container may ask for several rows with `data-skel-rows`.
 *
 * Scoped by the attribute rather than by a panel id on purpose: surfaces that
 * reuse this module without the seller's tab shell (the admin per-store page)
 * simply carry no `data-skel`, and this becomes a no-op there.
 */
function showRangePending(): void {
  // Scoped to this panel where there is one: `[data-skel]` is a generic hook and
  // another panel adopting it must not get blanked by a performance fetch.
  const root: ParentNode = document.getElementById('dash-panel-performance') ?? document;
  root.querySelectorAll<HTMLElement>('[data-skel]').forEach((el) => {
    const rows = Math.max(1, Math.min(20, Number(el.dataset.skelRows ?? 1) || 1));
    // The value lands inside class="…". It comes from the page's own SKEL map
    // today, but this is an attribute-interpolation sink either way, and the
    // repo has already shipped one escaper that skipped `"` — so strip the
    // characters that could break out rather than trusting the call site.
    const cls = (el.dataset.skel ?? '').replace(/["'<>&]/g, '');
    el.innerHTML = Array.from({ length: rows },
      () => `<span class="skel-bar inline-block align-middle ${cls}" aria-hidden="true"></span>`).join('');
  });
  document.getElementById('perf-kpis')?.setAttribute('aria-busy', 'true');
  document.getElementById('perf-top-products')?.setAttribute('aria-busy', 'true');
}

/**
 * The counterpart for a load that will never arrive: replace the placeholders
 * with an em dash. A shimmer that never resolves reads as "still working" and
 * the seller waits for a number that is not coming.
 */
function showRangeUnavailable(): void {
  const root: ParentNode = document.getElementById('dash-panel-performance') ?? document;
  root.querySelectorAll<HTMLElement>('[data-skel]').forEach((el) => {
    el.innerHTML = '<span style="color:var(--color-muted)">—</span>';
  });
  document.getElementById('perf-kpis')?.removeAttribute('aria-busy');
  document.getElementById('perf-top-products')?.removeAttribute('aria-busy');
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

  // Profitability breakdown (gross → (commission) → net).
  const grossEl = document.getElementById('perf-gross');
  const commissionEl = document.getElementById('perf-commission');
  const commissionRateEl = document.getElementById('perf-commission-rate');
  const netEl = document.getElementById('perf-net');
  if (grossEl) grossEl.textContent = formatPrice(summary.totalRevenue);
  if (commissionEl) commissionEl.textContent = `(${formatPrice(summary.platformCommission)})`;
  if (commissionRateEl) commissionRateEl.textContent = String(summary.commissionRate);
  if (netEl) netEl.textContent = formatPrice(summary.netProfit);

  paintCharts(summary, i18n, true);

  const topProducts = document.getElementById('perf-top-products');
  // Same treatment as the charts: these rows sit at the very bottom of the panel, so
  // their bars are the ones most likely to grow while off-screen.
  if (topProducts) { renderTopProducts(topProducts, summary, i18n); armEntrance(topProducts); }

  // Every skeleton above has just been overwritten with a real value, so the
  // panel is no longer busy. Paired with the aria-busy the server renders when
  // it skips the summary (dashboard.astro) — without this the region would
  // stay "busy" forever and a screen reader would never announce the result.
  document.getElementById('perf-kpis')?.removeAttribute('aria-busy');
  topProducts?.removeAttribute('aria-busy');
}

// Delegated from the (persistent) chart container, not the individual
// <rect> bars — renderSummary() replaces the SVG's innerHTML wholesale on
// every range-picker fetch, which would otherwise silently drop any
// listener bound to a bar directly.
function initChartTooltips(): void {
  ['perf-revenue-chart', 'perf-orders-chart', 'perf-visitors-chart', 'pperf-revenue-chart', 'pperf-views-chart'].forEach((id) => {
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
    // A synthetic calendar date (day 0 of next month = last day of this one), built
    // and read in UTC — see business-day.ts on why an axis cursor is not an instant.
    const to = calendarDayISO(new Date(Date.UTC(y ?? 1970, m ?? 1, 0)));
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
        <span class="inline-block w-3 h-3 rounded-[var(--radius-sm)] shrink-0" style="background:${s.color}"></span>
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

  // The range the figures currently ON SCREEN belong to. Seeded from what the
  // server rendered and re-captured only when a load actually rendered, so a
  // failed switch can put the picker back where the numbers are. Without it the
  // trigger names the range the seller just chose while every figure below it
  // is still the previous one's — the same misreading the in-flight
  // placeholders exist to prevent, only permanent and silent.
  let shownRange = {
    preset: picker.dataset.activePreset ?? '',
    label: label?.textContent ?? '',
    from: fromInput?.value ?? '',
    to: toInput?.value ?? '',
  };
  function captureShownRange(from: string, to: string): void {
    shownRange = { preset: picker!.dataset.activePreset ?? '', label: label?.textContent ?? '', from, to };
  }
  function restoreShownRange(): void {
    if (shownRange.preset) picker!.dataset.activePreset = shownRange.preset;
    else delete picker!.dataset.activePreset;
    if (label) label.textContent = shownRange.label;
    if (fromInput) fromInput.value = shownRange.from;
    if (toInput) toInput.value = shownRange.to;
  }

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
    const clear = `<button type="button" role="option" aria-selected="${!selectedProductId}" data-product-id="" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] [color:var(--color-muted)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" style="${!selectedProductId ? 'font-weight:700' : ''}">${escHtml(i18n.perfProductClear ?? '')}</button>
      <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>`;
    const options = productList.map((p) => {
      const selected = p.id === selectedProductId;
      return `<button type="button" role="option" aria-selected="${selected}" data-product-id="${escHtml(p.id)}" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.85rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" style="${selected ? 'font-weight:700;color:var(--color-primary)' : ''}">${escHtml(p.name)}</button>`;
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
  // The top-products bars are the one entrance the SERVER renders live (the charts' SSR
  // copy is static because the client repaints them anyway; these rows are never
  // repainted, so taking their animation away would mean a no-JS page lost it for good).
  // Arm that copy here, so it gets the same hold-until-visible + strip-once-played
  // treatment as everything the client paints — without this it was the one thing on the
  // panel that still replayed its animation on every tab switch.
  armEntrance(document.getElementById('perf-top-products'));

  const revChart = document.getElementById('perf-revenue-chart');
  if (revChart && 'ResizeObserver' in window) {
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        // revChart.clientWidth, not chartPixelWidth() — the latter falls back to 640 for a
        // hidden panel, which would read as a real measurement and paint (and animate) a
        // chart nobody can see.
        const w = chartPixelWidth();
        // `!paintedOnce` also fires the very first paint when the measured width happens to
        // equal the SSR one, which the width comparison alone would skip — leaving the
        // server's static chart on screen and the entrance never played.
        if (lastSummary && revChart.clientWidth > 0 && (!paintedOnce || w !== lastChartWidth)) {
          paintCharts(lastSummary, i18n, !paintedOnce);
        }
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
    // Every figure on screen belongs to the range the seller just left. Leaving
    // them up while the new one is in flight presents last month's revenue as
    // this month's — the seller has no way to tell which one they are reading
    // (owner, 2026-07-31: "רואים עדיין את הנתונים של הזמן הקודם"). So blank them
    // to placeholders, but only if the fetch is still running at 180ms: on a
    // fast response the swap would be a flicker and nothing else, the same
    // threshold the breakdown modal above already uses.
    let rendered = false;
    const pendingTimer = window.setTimeout(showRangePending, 180);
    try {
      // A surrounding page may pin extra query params onto every range fetch
      // (the admin tab keeps its store-table search/sort/page here) so a range
      // change comes back with that view already applied, instead of silently
      // resetting the table under an unchanged search box. Read live, not once.
      const extra = picker!.dataset.extraParams ? `&${picker!.dataset.extraParams}` : '';
      const res = await fetch(`${endpoint}?storeSlug=${encodeURIComponent(storeSlug)}&from=${from}&to=${to}${extra}`);
      if (!res.ok) return;
      const data = await res.json() as { ok?: boolean; summary?: PerformanceSummary };
      if (data.summary) { renderSummary(data.summary, i18n); rendered = true; }
      // Let a surrounding page augment the same fetch with its own extra data
      // (the admin platform tab's per-store breakdown + GMV split card read
      // `stores`/`totalStores` off this response). Harmless where unlistened.
      document.dispatchEvent(new CustomEvent('perf:loaded', { detail: data }));
    } catch { /* handled by the restore below, same as any other failed path */ }
    finally {
      window.clearTimeout(pendingTimer);
      // Released FIRST: everything below paints, and a throw in any of it would
      // otherwise leave the guard latched and every later range switch a no-op.
      loading = false;
      if (rendered) captureShownRange(from, to);
      else {
        // Nothing replaced the figures: a non-2xx status, a body with no
        // summary, or a thrown fetch. All three leave a shimmer up forever
        // unless something puts figures back — and one `catch` covers only the
        // third, which is why this sits in `finally` and keys off `rendered`.
        // Deliberately NOT gated on whether the 180ms placeholders were painted:
        // a failure that comes back faster than that leaves the SERVER-rendered
        // skeletons on screen instead, and those shimmer just as forever.
        if (lastSummary) {
          // Last-known figures, and the picker put back to the range they are
          // actually from. Restoring the numbers without the label is what makes
          // last month's revenue read as this month's.
          renderSummary(lastSummary, i18n);
          restoreShownRange();
        } else {
          // Nothing to fall back to (the very first load failed). Say so rather
          // than animate a placeholder that will never be filled.
          showRangeUnavailable();
        }
        // Always out loud. A range switch that silently does nothing reads as a
        // dead control, and a silent revert reads as never having been clicked.
        showErrorToast(i18n.perfErrorLoading ?? 'Error loading data.');
      }
    }
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
    const presetsHtml = PRESETS.map((p) => `<button type="button" class="product-menu__item flex items-center gap-2 w-full py-[.45rem] px-3 rounded-[var(--radius-sm)] bg-transparent border-0 cursor-pointer font-[inherit] text-[.875rem] [color:var(--color-text)] text-start transition-colors duration-100 hover:bg-[color:var(--color-bg)]" data-preset="${p}" style="${p === activePreset ? 'font-weight:700;color:var(--color-primary)' : ''}">${i18n[PRESET_LABEL_KEY[p]] ?? p}</button>`).join('');
    // Custom-range row mirrors the advertising picker: both date fields AND the
    // inline Apply sit on ONE line (so the button never falls below the fold,
    // forcing a scroll — CURRENT_TASK item 1). A labelled sub-group makes clear
    // this Apply commits only the custom dates, not "the whole menu".
    return `${presetsHtml}
      <div class="product-menu__divider h-px bg-[color:var(--color-border)] my-[.3rem]"></div>
      <div class="px-3 pt-1.5 pb-2">
        <div class="text-[.72rem] [color:var(--color-muted)] mb-1.5">${i18n.perfPresetCustom ?? 'Custom'}</div>
        <div class="flex items-center gap-1.5" dir="ltr">
          <input type="date" data-range-from value="${fromInput?.value ?? ''}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
          <span class="muted text-[0.8rem] shrink-0">–</span>
          <input type="date" data-range-to value="${toInput?.value ?? ''}" class="font-[inherit] text-[.8rem] [color:var(--color-text)] bg-[color:var(--color-surface)] border [border-color:var(--color-border)] rounded-full py-[.3rem] px-[.5rem] outline-none min-w-0 flex-1" />
          <button type="button" class="btn btn--sm btn--ghost shrink-0" data-range-apply>${i18n.perfApply ?? 'Apply'}</button>
        </div>
      </div>`;
  }

  trigger?.addEventListener('click', () => {
    if (rangePortal.currentTrigger() === trigger) { rangePortal.close(); return; }
    rangePortal.open(trigger, '19rem', buildPanelHtml, (portal) => {
      // Show the whole picker (7 presets + the custom row with Apply) without an
      // inner scrollbar — the shared portal caps at 320px, which cut off Apply
      // and forced a scroll (CURRENT_TASK item 1). 30rem clears the full content;
      // min() still guards a very short viewport.
      portal.style.maxHeight = 'min(80vh, 30rem)';
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

  // ── Lazy first-load (CURRENT_TASK item 1) ────────────────────────────────
  // When Performance isn't the seller dashboard's landing tab, the server skips
  // buildPerformanceSummary() entirely, so #perf-initial-summary is null and
  // lastSummary stays unseeded above. Fetch the default range the first time the
  // panel is actually revealed (or immediately when there's no tab gating — e.g.
  // the admin per-store page — or the panel is already visible via deep-link). A
  // seeded lastSummary means the server already rendered it, so there's nothing
  // to do.
  if (!lastSummary) {
    const perfPanel = document.getElementById('dash-panel-performance');
    const lazyLoad = () => { void loadRange(fromInput?.value ?? '', toInput?.value ?? ''); };
    if (!perfPanel || !perfPanel.hidden) lazyLoad();
    else perfPanel.addEventListener('dashtab:show', lazyLoad, { once: true });
  }
}
