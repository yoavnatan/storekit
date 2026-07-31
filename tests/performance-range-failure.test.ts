/**
 * @vitest-environment jsdom
 *
 * What the seller sees when a range switch does NOT come back.
 *
 * Two ways this went wrong, both of them quiet:
 *  1. The recovery was gated on the 180ms placeholder timer having fired. A
 *     failure that answers faster than that — a 500, an offline fetch — skipped
 *     it entirely, leaving the SERVER-rendered skeletons shimmering forever with
 *     nothing ever said.
 *  2. On a failure with earlier figures to fall back to, those figures were put
 *     back while the range trigger kept the label of the range the seller had
 *     just chosen. Last month's revenue, presented as this month's — the exact
 *     misreading the in-flight placeholders exist to prevent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SUMMARY = {
  granularity: 'day',
  points: [{ key: '2026-07-01', label: '1.7', revenue: 1000, orders: 4, views: 90, uniqueVisitors: 60 }],
  totalRevenue: 1000, totalOrders: 4, avgOrderValue: 250, totalViews: 90,
  totalUniqueVisitors: 60, conversionRate: 4.4, topProducts: [],
  commissionRate: 10, platformCommission: 100, netProfit: 900,
};

/** The parts of the panel this path actually touches, as the server renders them. */
function mount(withServerSummary: boolean): void {
  document.body.innerHTML = `
    <div id="dash-panel-performance">
      <div id="perf-range-picker" data-store-slug="s1" data-active-preset="month"></div>
      <input id="perf-from-input" value="2026-07-01" />
      <input id="perf-to-input" value="2026-07-31" />
      <button id="perf-range-trigger"></button>
      <span id="perf-range-label">This month</span>
      <dl id="perf-kpis" aria-busy="true">
        <dd id="perf-kpi-revenue" data-skel="w-4"><span class="skel-bar"></span></dd>
        <dd id="perf-kpi-orders" data-skel="w-4"><span class="skel-bar"></span></dd>
        <dd id="perf-kpi-avg" data-skel="w-4"><span class="skel-bar"></span></dd>
        <dd id="perf-kpi-visitors" data-skel="w-4"><span class="skel-bar"></span></dd>
        <dd id="perf-kpi-unique" data-skel="w-4"><span class="skel-bar"></span></dd>
        <dd id="perf-kpi-conversion" data-skel="w-4"><span class="skel-bar"></span></dd>
      </dl>
      <span id="perf-gross" data-skel="w-4"></span>
      <span id="perf-commission" data-skel="w-4"></span>
      <span id="perf-commission-rate" data-skel="w-4"></span>
      <span id="perf-net" data-skel="w-4"></span>
      <div id="perf-revenue-chart" data-skel="w-4"></div>
      <div id="perf-orders-chart" data-skel="w-4"></div>
      <div id="perf-visitors-chart" data-skel="w-4"></div>
      <div id="perf-top-products" data-skel="w-4" data-skel-rows="3" aria-busy="true"></div>
    </div>
    ${withServerSummary
      ? `<script type="application/json" id="perf-initial-summary">${JSON.stringify(SUMMARY)}</script>`
      : ''}
  `;
}

/** Every `toast:show` raised from here on. */
function collectToasts(): string[] {
  const seen: string[] = [];
  window.addEventListener('toast:show', (e) => seen.push((e as CustomEvent).detail.title));
  return seen;
}

/** Fresh module per test — `lastSummary` is module state and would leak across them. */
async function initPanel(): Promise<void> {
  vi.resetModules();
  const mod = await import('../src/scripts/dashboard/performance.js');
  mod.initPerformanceTab();
}

describe('performance range switch that fails', () => {
  // Real timers on purpose: the whole point is a failure that lands BEFORE the
  // 180ms placeholder timer, so the recovery must not depend on that timer.
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('says so and stops the shimmer when the very first load fails fast', async () => {
    mount(false);
    const toasts = collectToasts();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await initPanel();
    await vi.waitFor(() => expect(toasts).toHaveLength(1));

    // Nothing left animating, and the region no longer claims to be busy.
    expect(document.querySelectorAll('#dash-panel-performance .skel-bar')).toHaveLength(0);
    expect(document.getElementById('perf-kpis')?.getAttribute('aria-busy')).toBeNull();
    expect(document.getElementById('perf-top-products')?.getAttribute('aria-busy')).toBeNull();
  });

  it('puts the range label back with the figures it belongs to', async () => {
    mount(true);  // the server rendered a summary — there IS something to fall back to
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await initPanel();  // seeds lastSummary from #perf-initial-summary, no fetch

    const toasts = collectToasts();
    // Drive the real path: open the range picker, choose a different preset.
    document.getElementById('perf-range-trigger')!.click();
    const preset = document.querySelector<HTMLButtonElement>('[data-preset]:not([data-preset="month"])');
    expect(preset, 'the range portal should have rendered its presets').not.toBeNull();
    preset!.click();

    // The label moved to the new range before the fetch — that is the bug's setup.
    expect(document.getElementById('perf-range-label')!.textContent).not.toBe('This month');

    await vi.waitFor(() => expect(toasts.length).toBeGreaterThan(0));

    // The figures are the server's again, so the picker must be the server's too.
    expect(document.getElementById('perf-range-label')!.textContent).toBe('This month');
    expect((document.getElementById('perf-from-input') as HTMLInputElement).value).toBe('2026-07-01');
    expect((document.getElementById('perf-to-input') as HTMLInputElement).value).toBe('2026-07-31');
    expect(document.getElementById('perf-range-picker')!.dataset.activePreset).toBe('month');
  });
});
