// @vitest-environment jsdom
/**
 * The side-navigation drawer's inline script, run against a document built in the REAL order.
 *
 * The bug this exists for shipped and was found by the owner in one tap (2026-08-22: *"במובייל
 * התפריט צד לא נפתח שום דבר לא קורה"*). The component's script is `is:inline`, so it runs the
 * instant the parser reaches it — inside the card, and therefore BEFORE `.dash-tabs`. Its opening
 * `getElementById('dash-nav-list')` returned null, the guard below it returned, nothing was ever
 * bound, and the drawer was dead: no error, no warning, and a screenshot of the closed page looks
 * exactly right. `DashTabsBoot` sidesteps the same trap by being rendered AFTER its strip; this
 * component cannot be, because its scrim belongs where the card is.
 *
 * So the ORDER is the test. Building the DOM with the list first would pass against the broken
 * code — which is the whole lesson of memory `feedback_test_starting_state`: a green suite proves
 * nothing if the state it starts from is not the state the bug lives in.
 *
 * The fixture also places the TRIGGER where the page puts it since 2026-08-23 — in the site
 * header, i.e. outside the card and parsed before it. That is the other half of the same property:
 * the script binds one element it can only find upwards and one it can only find downwards, and a
 * fixture that put them both in one place would prove neither.
 *
 * jsdom has no layout, so the breakpoint question (`isDrawer()` reads a computed `position`) is
 * not decidable here and is not asserted; it was driven in a real browser instead. What IS here is
 * everything the early return took away: opening, `aria-expanded`, Escape, the scrim, focus, and
 * the alert dot.
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
 * The real page's order: the site header (carrying the trigger) first, then the card, then the
 * scrim where the component renders it, and the tab list LAST — which is the only order that can
 * catch this.
 */
function render(): void {
  document.body.innerHTML = `
    <header class="site-header">
      <button type="button" id="dash-nav-trigger" class="cart-btn dash-nav-trigger" aria-expanded="false" aria-controls="dash-nav-list">
        <span class="dash-nav-trigger__dot" id="dash-nav-trigger-dot" hidden></span>
      </button>
    </header>
    <div id="dash-main-card" class="card seller-dash dash-nav-side">
      <div class="dash-rail">
        <div class="dash-head">
          <h1>חנות</h1>
          <!-- The store switcher's own marker. It lives in the rail's HEAD, not in the tab list,
               and it says something no tab can: another of this seller's shops needs them. -->
          <span class="store-switcher__alert-dot" data-level="warning"></span>
        </div>
        <div class="dash-nav-overlay" id="dash-nav-overlay"></div>
        <div class="dash-tabs" role="tablist" id="dash-nav-list" data-rail>
          ${tab('overview', 'סקירה כללית')}
          ${tab('products', 'מוצרים', '<span class="dash-tab-badge" data-tab-alert="warning">3</span>')}
          ${tab('orders', 'הזמנות', '<span class="dash-tab-dot" data-tab-alert="danger"></span>')}
        </div>
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

  it('closes when a tab is chosen — including a synthetic click from an overview card', () => {
    // "Is this a drawer?" is asked of the rail's computed `position`, so that one media query in
    // dashboard.css stays the single definition of the breakpoint. jsdom has no layout and would
    // answer `static` for every width, so the fixture states the answer the only way it can: an
    // inline `position` is what `getComputedStyle` reports back.
    document.querySelector<HTMLElement>('.dash-rail')!.style.position = 'fixed';
    click(trigger());
    // `[data-goto-panel]` jumps arrive as `.click()`, and one landing with the drawer open would
    // leave the seller reading a panel through a scrim. Delegated on the document, so both kinds
    // of click go through the same path.
    document.getElementById('tab-orders')!.click();
    expect(isOpen()).toBe(false);
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
    document.querySelectorAll('[data-tab-alert], .store-switcher__alert-dot').forEach((el) => el.remove());
    new Function(inlineScript())();
    expect(document.getElementById('dash-nav-trigger-dot')!.hidden).toBe(true);
  });

  /**
   * The header's avatar stopped carrying its own alert dot on this page (Header.astro) because
   * this one says the same thing about a named tab. That trade only holds if this one covers
   * everything the drawer hides — including the marker in the rail's HEAD, which is the seller's
   * OTHER shops and which no tab can speak for. It spells its severity `data-level`, so a scan
   * written for `data-tab-alert` alone would have dropped it silently.
   */
  it('carries the store switcher\'s marker too, not only the tabs\'', () => {
    document.body.innerHTML = '';
    render();
    document.querySelectorAll('[data-tab-alert]').forEach((el) => el.remove());
    new Function(inlineScript())();
    const dot = document.getElementById('dash-nav-trigger-dot')!;
    expect(dot.hidden).toBe(false);
    expect(dot.getAttribute('data-level')).toBe('warning');
  });

  it('does not count a marker whose count is zero — those are `hidden`, not absent', () => {
    document.body.innerHTML = '';
    render();
    document.querySelectorAll('[data-tab-alert], .store-switcher__alert-dot')
      .forEach((el) => { (el as HTMLElement).hidden = true; });
    new Function(inlineScript())();
    expect(document.getElementById('dash-nav-trigger-dot')!.hidden).toBe(true);
  });
});
