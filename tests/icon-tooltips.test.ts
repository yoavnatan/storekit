// @vitest-environment jsdom
//
// The site-wide hover label for icon-only controls. Every case below is one the first version got
// wrong and the user caught by hovering:
//
//  - The header bell and cart wrap a live COUNT BADGE, so "does this control contain any text?"
//    switched their tooltips off the moment the count was non-zero — and the store product card's
//    add-to-cart wraps a hidden qty readout, so it never had one at all.
//  - The avatar button's dropdown is rendered inside the button, so hovering into the open menu
//    resolved back up to the trigger and drew its tooltip over the menu.
//
// It also guards the class this feature CREATED: an aria-label used to be screen-reader-only, so
// a hardcoded English one was invisible; now it is visible text on a Hebrew-first site.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The module bails out entirely without hover, which is correct on touch but means the tests have
// to claim a mouse.
vi.stubGlobal('matchMedia', (q: string) => ({
  matches: q.includes('hover: hover'),
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const { initIconTooltips } = await import('../src/scripts/icon-tooltips.js');
const OPEN_DELAY = 450;

let inited = false;
beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
  if (!inited) { initIconTooltips(); inited = true; } // one delegated listener, as in the app
});
afterEach(() => { vi.useRealTimers(); });

/** Hover an element and let the open delay elapse; returns the tooltip text, or null. */
function hover(el: Element): string | null {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(OPEN_DELAY + 10);
  const tip = document.querySelector('.dash-tooltip') as HTMLElement | null;
  return tip && !tip.hidden ? tip.textContent : null;
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

const ICON = '<svg aria-hidden="true"></svg>';

describe('which controls get a hover label', () => {
  it('labels a plain icon-only button', () => {
    expect(hover(mount(`<button aria-label="התראות">${ICON}</button>`))).toBe('התראות');
  });

  it('labels one that also holds a count badge', () => {
    // The header bell and cart. The count is not the control's label, so it must not suppress it.
    const el = mount(`<button aria-label="פתח עגלה">${ICON}<span class="cart-count">23</span></button>`);
    expect(hover(el)).toBe('פתח עגלה');
  });

  it('labels one holding a hidden quantity readout', () => {
    // The store product card's add-to-cart button.
    const el = mount(`<button aria-label="הוסף לעגלה">${ICON}<span style="display:none">1</span></button>`);
    expect(hover(el)).toBe('הוסף לעגלה');
  });

  it('stays silent when the label is already visible text', () => {
    expect(hover(mount(`<a aria-label="הזמנות">${ICON}<span>הזמנות</span></a>`))).toBeNull();
  });

  it('labels a button whose text label is hidden by CSS at this width', () => {
    // The dashboard toolbars keep the label span and hide it with CSS on mobile, so the buttons
    // that go icon-only are precisely the ones a layout-blind textContent read called "labelled".
    // jsdom has no innerText, so it is stubbed here the way a real layout would report it.
    const el = mount(`<button aria-label="עריכה מרובה">${ICON}<span style="display:none">עריכה מרובה</span></button>`);
    Object.defineProperty(el, 'innerText', { value: '', configurable: true });
    expect(hover(el)).toBe('עריכה מרובה');
  });

  it('labels a sort button whose visible text is only part of the label', () => {
    // "Sort by" is the part the column header does not say out loud — suppressing on a partial
    // match would have thrown away the only reason to show it.
    const el = mount(`<button aria-label="מיין לפי מחיר">${ICON}<span>מחיר</span></button>`);
    Object.defineProperty(el, 'innerText', { value: 'מחיר', configurable: true });
    expect(hover(el)).toBe('מיין לפי מחיר');
  });

  it('stays silent when the card around the control already prints the label', () => {
    // The store product card: the photo is a role="button" holding an <img> and labelled with the
    // product name, and the name is printed in full right under the picture. Resting on the photo
    // drew the product's own name over it (reported by hovering a card, 2026-07-31).
    const card = mount(`<li class="product-card">
        <div role="button" aria-label="חולצת פסים"><img src="x.jpg" alt="חולצת פסים"></div>
        <h3>חולצת פסים</h3>
      </li>`);
    expect(hover(card.querySelector('[role="button"]')!)).toBeNull();
  });

  it('stays silent when the label only joins two on-screen texts', () => {
    // The homepage carousel tile: ONE <a> whose accessible name is "name — price", with the name
    // and the price as two separate spans. The em-dash and the line break between them are the
    // only difference, and a literal comparison called that "not on screen", so every tile in the
    // moving row carried its own caption as a tooltip.
    const el = mount(`<a href="/x" aria-label="חולצת פסים — ₪120">
        <img src="x.jpg" alt="חולצת פסים">
        <span>חולצת פסים</span><span>₪120</span>
      </a>`);
    expect(hover(el)).toBeNull();
  });

  it('still labels a control in that card whose label is nowhere on it', () => {
    // The guard on the fix above: the wishlist heart sits in the same card and says nothing.
    const card = mount(`<li class="product-card">
        <button aria-label="הוסף למועדפים">${ICON}</button>
        <h3>חולצת פסים</h3>
      </li>`);
    expect(hover(card.querySelector('button')!)).toBe('הוסף למועדפים');
  });

  it('stays silent on a control with no icon at all', () => {
    expect(hover(mount('<button aria-label="שמור">שמירה</button>'))).toBeNull();
  });

  it('stays silent while the menu it opened is showing', () => {
    // aria-expanded="true": the panel is on screen, and it is often rendered INSIDE the trigger.
    const el = mount(`<button aria-label="תפריט משתמש" aria-expanded="true">${ICON}<div><a href="/x">הזמנות</a></div></button>`);
    expect(hover(el)).toBeNull();
    expect(hover(el.querySelector('a')!)).toBeNull();
  });

  it('labels the same trigger once it is closed again', () => {
    const el = mount(`<button aria-label="תפריט משתמש" aria-expanded="false">${ICON}</button>`);
    expect(hover(el)).toBe('תפריט משתמש');
  });

  it('defers to a control that already has its own tooltip', () => {
    expect(hover(mount(`<button aria-label="יחס המרה" data-tooltip="הסבר">${ICON}</button>`))).toBeNull();
    expect(hover(mount(`<button aria-label="העתק" title="העתק">${ICON}</button>`))).toBeNull();
  });

  // The explicit opt-out, for a control whose content IS the thing — a product
  // photo does not need "click to zoom" floating over it, nor its own name over
  // each thumbnail (user, 2026-08-01). The aria-label must survive: this turns
  // off the hover label, never the accessible name.
  it('stays silent on a control marked data-no-tooltip', () => {
    const el = mount(`<button aria-label="לחצו להגדלה" data-no-tooltip><img src="/x.jpg" alt=""></button>`);
    expect(hover(el)).toBeNull();
    expect(el.getAttribute('aria-label')).toBe('לחצו להגדלה');
  });

  it('still labels the same control once the opt-out is gone', () => {
    const el = mount(`<button aria-label="לחצו להגדלה"><img src="/x.jpg" alt=""></button>`);
    expect(hover(el)).toBe('לחצו להגדלה');
  });
});

describe('moving between controls', () => {
  it('drops the previous control\'s label immediately', () => {
    // Hovering + and then sliding onto add-to-cart used to leave the +'s label sitting there.
    document.body.innerHTML =
      `<button id="inc" aria-label="הגדל כמות">${ICON}</button>` +
      `<button id="add" aria-label="הוסף לעגלה">${ICON}</button>`;
    expect(hover(document.getElementById('inc')!)).toBe('הגדל כמות');
    document.getElementById('add')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const tip = document.querySelector('.dash-tooltip') as HTMLElement;
    expect(tip.hidden).toBe(true); // gone at once, not after the next open delay
    vi.advanceTimersByTime(OPEN_DELAY + 10);
    expect(tip.textContent).toBe('הוסף לעגלה');
  });

  it('drops a pending label when the pointer leaves for ordinary page', () => {
    // Hover the bell, flick the cursor away before the delay elapses — the tooltip used to appear
    // anyway, 450ms later, with the pointer nowhere near it. The early-return matched null ===
    // null ("still on nothing") and so never cancelled the countdown.
    document.body.innerHTML =
      `<button id="bell" aria-label="התראות">${ICON}<span>2</span></button><p id="text">שלום</p>`;
    const bell = document.getElementById('bell')!;
    bell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(200); // still counting down
    document.getElementById('text')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(OPEN_DELAY + 50);
    const tip = document.querySelector('.dash-tooltip') as HTMLElement | null;
    expect(tip === null || tip.hidden).toBe(true);
  });

  it('renders the label as text, never as markup', () => {
    // aria-labels carry seller-supplied product names.
    const el = mount(`<button aria-label="<img src=x onerror=alert(1)>">${ICON}</button>`);
    hover(el);
    const tip = document.querySelector('.dash-tooltip')!;
    expect(tip.querySelector('img')).toBeNull();
    expect(tip.textContent).toContain('<img');
  });
});

// ── Guard: an aria-label on an icon control is now VISIBLE TEXT ──

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) srcFiles(full, out);
    else if (/\.(ts|astro)$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Placeholders in static markup that client JS replaces from i18n before the element can ever be
 * hovered (both drawers are hidden until their render function runs). Listed with the element id
 * so the claim is checkable, not a blanket exemption.
 */
const REPLACED_BY_JS_FROM_I18N = ['cart-close', 'wishlist-close'];

describe('every sort and filter control names what it sorts or filters', () => {
  // A column header button showed only the column word plus a chevron, and on mobile only the
  // chevron — so "what does this do?" had no answer anywhere, for a sighted user or a screen
  // reader. The label carries the verb ("sort by …"), which is also what the hover tooltip reads.
  it.each([
    ['sort-btn', /sortByLabel/],
    ['combo-sort-btn', /sortByLabel|sortBy\b/],
    ['combo-filter-btn', /filterByLabel|variantFilterAriaPrefix|filterFunnelAria/],
  ])('%s', (cls, expected) => {
    const offenders: string[] = [];
    for (const file of srcFiles('src')) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<button[^>]*class="([^"]*)"[^>]*>/g)) {
        const tag = m[0];
        // Exact class token: `\b` would let "combo-sort-btn" answer for "sort-btn" (a hyphen is
        // a word boundary), which quietly merged two different expectations into one.
        if (!m[1]!.split(/\s+/).includes(cls)) continue;
        // `.sort-btn` is the column-heading LOOK, not a promise about behaviour: the SEO column's
        // heading wears it and opens the filter (it has to be no wider than the 21px gauge it sits
        // over, so it cannot afford a word plus a separate funnel). Judge such a heading by what it
        // does — this test's own title is "names what it sorts OR FILTERS" — not by its class.
        const isFilterTrigger = /data-filter-funnel-col=/.test(tag);
        const want = isFilterTrigger ? /filterByLabel|filterFunnelAria/ : expected;
        const label = /aria-label=(?:"([^"]*)"|\{([^}]*)\})/.exec(tag);
        const value = label?.[1] ?? label?.[2] ?? '';
        if (!value || !want.test(value)) {
          offenders.push(`${file} → ${tag.slice(0, 120)}`);
        }
      }
    }
    expect(
      offenders,
      `Give each of these an aria-label built from the i18n "sort by"/"filter by" string plus the
column name — it is the control's accessible name and its hover tooltip:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('the i18n keys those labels are built from exist in both locales', () => {
  // A hover label is read from aria-label, so a key present in `he` and forgotten in `en` renders
  // the word "undefined" in a tooltip — visible, and invisible to a Hebrew reviewer. The key list
  // is derived from the source rather than typed here, so it cannot drift from the markup.
  it.each(['he', 'en'] as const)('%s', async (lang) => {
    const { getT } = await import('../src/i18n/index.js');
    const t = getT(lang) as unknown as Record<string, Record<string, unknown>>;
    const missing: string[] = [];
    for (const file of srcFiles('src')) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/aria-label=\{`([^`]*)`\}/g)) {
        // `${d.colName}` / `${t.dashboard.orderDate}` / `${t.buyerDashboard.msgColProduct}`
        for (const ref of m[1]!.matchAll(/\$\{(?:d|t\.(\w+))\.(\w+)(?:\s|\}|\?)/g)) {
          const ns = ref[1] ?? 'dashboard'; // bare `d` is t.dashboard in the seller dashboard
          const key = ref[2]!;
          const val = t[ns]?.[key];
          if (typeof val !== 'string' || !val.trim()) missing.push(`${file}: t.${ns}.${key}`);
        }
      }
    }
    expect([...new Set(missing)], `resolved against locale "${lang}"`).toEqual([]);
  });
});

describe('no icon control carries a hardcoded English label', () => {
  it('every button/a/summary aria-label literal in src/ is Hebrew or from i18n', () => {
    const offenders: string[] = [];
    for (const file of srcFiles('src')) {
      const src = readFileSync(file, 'utf8');
      // Opening tag of a control, up to its '>', with a quoted (not {expression}) aria-label.
      for (const m of src.matchAll(/<(?:button|a|summary)\b[^>]*?aria-label="([^"{}]+)"[^>]*>/gi)) {
        const label = m[1]!;
        if (!/[A-Za-z]/.test(label)) continue;                       // Hebrew, or an icon glyph
        if (REPLACED_BY_JS_FROM_I18N.some((id) => m[0].includes(id))) continue;
        offenders.push(`${file} → aria-label="${label}"`);
      }
    }
    expect(
      offenders,
      `An aria-label is no longer screen-reader-only: scripts/icon-tooltips.ts shows it as the
hover label of any icon control, so a hardcoded English string is visible English on a
Hebrew-first site. Move these to src/i18n/translations.ts and read them through getT(lang):
${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
