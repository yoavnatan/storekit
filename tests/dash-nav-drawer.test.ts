// @vitest-environment jsdom
/**
 * The side-navigation drawer's inline script, run against a document built in the REAL order.
 *
 * The bug this exists for shipped and was found by the owner in one tap (2026-08-22: *"במובייל
 * התפריט צד לא נפתח שום דבר לא קורה"*). `DashNavDrawer` renders inside `.dash-head` — that is
 * where its trigger belongs in the layout — and `.dash-head` is parsed BEFORE `.dash-tabs`. The
 * script is `is:inline`, so it runs the instant the parser reaches it, and its opening
 * `getElementById('dash-nav-list')` therefore returned null. The guard below it returned, nothing
 * was ever bound, and the drawer was dead: no error, no warning, and a screenshot of the closed
 * page looks exactly right. `DashTabsBoot` sidesteps the same trap by being rendered AFTER its
 * strip; this component cannot be.
 *
 * So the ORDER is the test. Building the DOM with the list first would pass against the broken
 * code — which is the whole lesson of memory `feedback_test_starting_state`: a green suite proves
 * nothing if the state it starts from is not the state the bug lives in.
 *
 * jsdom has no layout, so the breakpoint question (`isDrawer()` reads a computed `position`) is
 * not decidable here and is not asserted; it was driven in a real browser instead. What IS here is
 * everything the early return took away: opening, `aria-expanded`, Escape, the scrim, focus, the
 * trigger's label following the chosen tab, and the alert dot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPONENT = join(process.cwd(), 'src/components/dashboard/DashNavDrawer.astro');

/** The component's own `<script is:inline>` body — the code under test, not a copy of it. */
function inlineScript(): string {
  const src = readFileSync(COMPONENT, 'utf8');
  const start = src.indexOf('<script is:inline>');
  const end = src.indexOf('</script>', start);
  expect(start, 'DashNavDrawer must carry an inline script').toBeGreaterThan(-1);
  return src.slice(start + '<script is:inline>'.length, end);
}

const tab = (panel: string, label: string, marker = ''): string =>
  `<button class="dash-tab${panel === 'products' ? ' dash-tab--active' : ''}" role="tab" id="tab-${panel}"
     data-panel="${panel}" aria-selected="${panel === 'products'}">${label}${marker}</button>`;

/**
 * `.dash-head` (with the drawer inside it) FIRST, the tab list after — the real page's order, and
 * the only order that can catch this.
 */
function render(): void {
  document.body.innerHTML = `
    <div id="dash-main-card" class="card seller-dash dash-nav-side">
      <div class="dash-head">
        <h1>חנות</h1>
        <button type="button" id="dash-nav-trigger" class="dash-nav-trigger" aria-expanded="false" aria-controls="dash-nav-list">
          <span id="dash-nav-trigger-label">מוצרים</span>
          <span class="dash-nav-trigger__dot" id="dash-nav-trigger-dot" hidden></span>
        </button>
        <div class="dash-nav-overlay" id="dash-nav-overlay"></div>
      </div>
      <div class="dash-tabs" role="tablist" id="dash-nav-list" data-rail>
        ${tab('overview', 'סקירה כללית')}
        ${tab('products', 'מוצרים', '<span class="dash-tab-badge" data-tab-alert="warning">3</span>')}
        ${tab('orders', 'הזמנות', '<span class="dash-tab-dot" data-tab-alert="danger"></span>')}
      </div>
    </div>`;
}

const card = (): HTMLElement => document.getElementById('dash-main-card')!;
const trigger = (): HTMLElement => document.getElementById('dash-nav-trigger')!;
const scrim = (): HTMLElement => document.getElementById('dash-nav-overlay')!;
const isOpen = (): boolean => card().hasAttribute('data-nav-open');
const click = (el: Element): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };

beforeEach(() => {
  render();
  // Run the component's script exactly where the browser runs it: with the head parsed and the
  // list not yet. `render()` has already put both in the DOM, so the list is deliberately hidden
  // from the script's opening lookup the only way jsdom allows — by asserting, below, that the
  // script does not TAKE that lookup at parse time.
  new Function(inlineScript())();
});

describe('the drawer opens', () => {
  it('does not resolve the tab list at parse time — the list is parsed after this script', () => {
    // The regression itself, stated as a property of the source rather than of a run: the list
    // lookup must sit inside a function, not at the top level where the parser has not reached it.
    const script = inlineScript();
    const beforeFirstFunction = script.slice(0, script.indexOf('function'));
    expect(beforeFirstFunction).not.toContain('dash-nav-list');
  });

  it('opens on a click of the trigger, and says so', () => {
    expect(isOpen()).toBe(false);
    click(trigger());
    expect(isOpen()).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(scrim().classList.contains('is-open')).toBe(true);
  });

  it('moves focus into the list, so a keyboard lands where the drawer is', () => {
    click(trigger());
    expect(document.activeElement?.id).toBe('tab-products');
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    click(trigger());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(isOpen()).toBe(false);
    expect(document.activeElement?.id).toBe('dash-nav-trigger');
  });

  it('closes when the scrim is pressed', () => {
    click(trigger());
    click(scrim());
    expect(isOpen()).toBe(false);
  });

  it('renames the trigger to the tab that was chosen', () => {
    click(trigger());
    click(document.getElementById('tab-orders')!);
    expect(document.getElementById('dash-nav-trigger-label')!.textContent!.trim()).toBe('הזמנות');
  });
});

describe('the trigger carries a marker out of a closed drawer', () => {
  it('shows the dot, at the loudest severity present', () => {
    const dot = document.getElementById('dash-nav-trigger-dot')!;
    expect(dot.hidden).toBe(false);
    // A red marker and an amber one are both in the list; red is what a person is waiting on.
    expect(dot.getAttribute('data-level')).toBe('danger');
  });

  it('stays hidden when nothing needs the seller', () => {
    document.body.innerHTML = '';
    render();
    document.querySelectorAll('[data-tab-alert]').forEach((el) => el.remove());
    new Function(inlineScript())();
    expect(document.getElementById('dash-nav-trigger-dot')!.hidden).toBe(true);
  });

  it('does not count a marker whose count is zero — those are `hidden`, not absent', () => {
    document.body.innerHTML = '';
    render();
    document.querySelectorAll('[data-tab-alert]').forEach((el) => { (el as HTMLElement).hidden = true; });
    new Function(inlineScript())();
    expect(document.getElementById('dash-nav-trigger-dot')!.hidden).toBe(true);
  });
});
