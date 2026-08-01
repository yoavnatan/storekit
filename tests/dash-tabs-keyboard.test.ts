// @vitest-environment jsdom
//
// Keyboard access to a `.dash-tabs` strip (homepage, seller dashboard, /admin,
// buyer dashboard). The strip follows the ARIA roving-tabindex pattern: Tab
// moves INTO the strip and straight out again to the panel, and you move
// BETWEEN tabs with the arrow keys. That only works if exactly one tab is in
// the Tab order and it is the selected one — get that wrong and Tab drops the
// user on a tab they are not on, or (with no tabindex="0" anywhere) the strip
// becomes unreachable by keyboard entirely.
//
// It shipped wrong: initDashTabs() hardcoded index 0, overriding both the SSR
// value and anything __dashTabActivate had set, so landing on /?panel=liked
// put focus on "discover" (owner, 2026-08-01).
//
// The boot script is run here as REAL code extracted from DashTabsBoot.astro,
// for the same reason header-cart-badge.test.ts does it: a copy pasted into a
// test passes long after the shipped one has drifted.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initDashTabs } from '../src/scripts/dashboard/ui.js';

const TAB_IDS = ['discover', 'liked', 'buy-again', 'new'] as const;

/** The literal body of DashTabsBoot.astro's inline activation script. */
function bootScript(): string {
  const src = readFileSync(resolve(process.cwd(), 'src/components/dashboard/DashTabsBoot.astro'), 'utf8');
  const blocks = [...src.matchAll(/<script is:inline>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(blocks, 'DashTabsBoot.astro must have exactly one inline script').toHaveLength(1);
  return blocks[0]!;
}

/**
 * The homepage's strip as index.astro server-renders it, with `active` opened —
 * including its roving tabindex, which is the thing under test.
 */
function renderStrip(active: string): void {
  document.body.innerHTML = `
    <div class="dash-tabs" role="tablist">
      ${TAB_IDS.map((id) => `
        <button class="dash-tab${id === active ? ' dash-tab--active' : ''}"
                role="tab" id="tab-${id}" data-panel="${id}"
                aria-selected="${id === active}"
                tabindex="${id === active ? 0 : -1}">${id}</button>`).join('')}
    </div>
    ${TAB_IDS.map((id) => `<div id="dash-panel-${id}" class="dash-panel" role="tabpanel"${id === active ? '' : ' hidden'}></div>`).join('')}
  `;
}

const tabFor = (id: string): HTMLButtonElement =>
  document.getElementById(`tab-${id}`) as HTMLButtonElement;

const tabbable = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
    .filter((t) => t.getAttribute('tabindex') === '0')
    .map((t) => t.dataset.panel!);

function press(tab: HTMLElement, key: string): void {
  tab.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('dash-tabs keyboard navigation', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('dir', 'ltr');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(bootScript())();
  });

  it('leaves the SELECTED tab in the Tab order, not the first one', () => {
    renderStrip('liked');
    initDashTabs();
    expect(tabbable()).toEqual(['liked']);
  });

  it('keeps exactly one tab in the Tab order — never zero, never two', () => {
    for (const active of TAB_IDS) {
      renderStrip(active);
      initDashTabs();
      expect(tabbable()).toEqual([active]);
    }
  });

  it('falls back to the first tab when nothing is marked selected', () => {
    renderStrip('discover');
    for (const t of document.querySelectorAll('[role="tab"]')) t.setAttribute('aria-selected', 'false');
    initDashTabs();
    // A strip with no way in is worse than one whose entry point is arbitrary.
    expect(tabbable()).toEqual(['discover']);
  });

  it('ArrowRight moves to the next tab and takes the Tab order with it', () => {
    renderStrip('discover');
    initDashTabs();

    press(tabFor('discover'), 'ArrowRight');

    expect(document.activeElement).toBe(tabFor('liked'));
    expect(tabFor('liked').getAttribute('aria-selected')).toBe('true');
    expect(tabbable()).toEqual(['liked']);
    expect(document.getElementById('dash-panel-liked')?.hasAttribute('hidden')).toBe(false);
    expect(document.getElementById('dash-panel-discover')?.hasAttribute('hidden')).toBe(true);
  });

  it('ArrowLeft wraps from the first tab round to the last', () => {
    renderStrip('discover');
    initDashTabs();

    press(tabFor('discover'), 'ArrowLeft');

    expect(document.activeElement).toBe(tabFor('new'));
    expect(tabbable()).toEqual(['new']);
  });

  it('arrow keys are consumed, so the strip does not also scroll the page', () => {
    renderStrip('discover');
    initDashTabs();
    const e = new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    tabFor('discover').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  // The site ships RTL. An arrow key names a direction ON SCREEN, so in a strip
  // that runs right→left, ArrowRight must land on the tab visually to the right
  // — which is the PREVIOUS one in source order. Walking the DOM forward sent it
  // the wrong way in Hebrew, i.e. on the live site (owner, 2026-08-01).
  describe('RTL — arrows follow the screen, not the source order', () => {
    beforeEach(() => { document.documentElement.setAttribute('dir', 'rtl'); });

    it('ArrowRight moves to the tab rendered to the right (the previous one)', () => {
      renderStrip('liked');
      initDashTabs();

      press(tabFor('liked'), 'ArrowRight');

      expect(document.activeElement).toBe(tabFor('discover'));
      expect(tabbable()).toEqual(['discover']);
    });

    it('ArrowLeft moves to the tab rendered to the left (the next one)', () => {
      renderStrip('liked');
      initDashTabs();

      press(tabFor('liked'), 'ArrowLeft');

      expect(document.activeElement).toBe(tabFor('buy-again'));
      expect(tabbable()).toEqual(['buy-again']);
    });

    it('leaves the vertical arrows alone — direction mirrors the inline axis only', () => {
      renderStrip('liked');
      initDashTabs();

      press(tabFor('liked'), 'ArrowDown');
      expect(document.activeElement).toBe(tabFor('buy-again'));

      press(tabFor('buy-again'), 'ArrowUp');
      expect(document.activeElement).toBe(tabFor('liked'));
    });

    it('wraps the way the eye does: ArrowRight off the first tab reaches the last', () => {
      renderStrip('discover');
      initDashTabs();

      press(tabFor('discover'), 'ArrowRight');

      expect(document.activeElement).toBe(tabFor('new'));
    });
  });

  it('draws the focus ring INSIDE the tab — the strip clips anything outside it', () => {
    // `.dash-tabs` is a scroller (overflow-y:hidden) whose tabs fill its height,
    // so reset.css's outward `outline-offset: 2px` gets sliced off top and
    // bottom. jsdom cannot measure that, so this asserts the rule that prevents
    // it. Buying padding on the strip instead is NOT an alternative fix: its
    // measured height feeds --dash-tabs-h and six sticky/scroll consumers.
    const css = readFileSync(resolve(process.cwd(), 'src/styles/pages/dashboard.css'), 'utf8');
    expect(css).toMatch(/\.dash-tab:focus-visible\s*\{[^}]*outline-offset:\s*-\d/);
  });
});
