// @vitest-environment jsdom
/**
 * The seller's confirmation banner must actually reach the page.
 *
 * It stopped doing so at some point and nobody noticed for as long as it took the owner to press
 * "pause campaign" and report that the page twitched and nothing happened. The cause was a single
 * `?.` : `document.querySelector('.products-header')?.after(el)` against a class that no longer
 * exists in any markup. The banner was built, never inserted, and then scrolled to — so every
 * "saved" / "updated" / "deleted" message in five dashboard modules, 56 call sites, was invisible
 * while every one of the operations behind them succeeded.
 *
 * Two guards, because the bug had two halves:
 *   1. behaviour — the banner ends up IN the document, whatever the surrounding markup looks like;
 *   2. the class — a selector that JS anchors to must exist in the markup it anchors to, which is
 *      the half that rots silently during a redesign and the half no behaviour test can see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const scrolled = vi.hoisted(() => ({ targets: [] as Element[] }));
vi.mock('../src/scripts/dashboard/scroll-utils.js', () => ({
  scrollBelowPinnedChrome: (el: Element) => { scrolled.targets.push(el); },
}));

const { showStatus } = await import('../src/scripts/dashboard/status.js');

/** jsdom gives every element `offsetParent === null`; the module uses it to mean "on screen". */
function makeVisible(...els: (Element | null)[]): void {
  for (const el of els) {
    if (el) Object.defineProperty(el, 'offsetParent', { value: document.body, configurable: true });
  }
}

beforeEach(() => { document.body.innerHTML = ''; scrolled.targets = []; });

describe('the dashboard status banner', () => {
  it('lands under the header of the panel the seller is looking at', () => {
    document.body.innerHTML = `
      <main class="dash-main">
        <div id="dash-panel-products"><div class="dash-panel-head">A</div></div>
        <div id="dash-panel-advertising"><div class="dash-panel-head">B</div></div>
      </main>`;
    const advertising = document.getElementById('dash-panel-advertising');
    makeVisible(advertising, advertising!.querySelector('.dash-panel-head'));

    showStatus('נשמר');

    const banner = document.getElementById('ajax-status');
    expect(banner, 'the banner was never inserted').not.toBeNull();
    expect(banner!.isConnected).toBe(true);
    expect(banner!.textContent).toBe('נשמר');
    // Under the VISIBLE panel's header — not the first one in the document.
    expect(banner!.previousElementSibling?.textContent).toBe('B');
  });

  it('still appears when the visible panel has no header at all', () => {
    document.body.innerHTML = `<main class="dash-main"><div id="dash-panel-reports">rows</div></main>`;
    makeVisible(document.getElementById('dash-panel-reports'));
    showStatus('נשמר');
    expect(document.getElementById('ajax-status')?.isConnected).toBe(true);
  });

  it('falls back to the shell when no panel is on screen', () => {
    document.body.innerHTML = `<main class="dash-main"><p>x</p></main>`;
    showStatus('נשמר');
    expect(document.getElementById('ajax-status')?.isConnected).toBe(true);
  });

  it('never scrolls toward a banner that is not in the document', () => {
    // This is the exact shape of the reported bug: a page twitching toward nothing.
    document.body.innerHTML = '';
    showStatus('נשמר');
    for (const target of scrolled.targets) expect(target.isConnected).toBe(true);
  });

  it('announces itself, so an error is not only a colour', () => {
    document.body.innerHTML = `<main class="dash-main"><div id="dash-panel-orders">x</div></main>`;
    makeVisible(document.getElementById('dash-panel-orders'));
    showStatus('שגיאה', true);
    const banner = document.getElementById('ajax-status')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');
  });

  it('re-anchors instead of staying attached to a panel that has been swapped away', () => {
    document.body.innerHTML = `
      <main class="dash-main">
        <div id="dash-panel-products"><div class="dash-panel-head">A</div></div>
        <div id="dash-panel-orders"><div class="dash-panel-head">B</div></div>
      </main>`;
    const products = document.getElementById('dash-panel-products')!;
    makeVisible(products, products.querySelector('.dash-panel-head'));
    showStatus('first');

    // The seller switches tabs: the old panel is hidden, a new one is shown.
    Object.defineProperty(products.querySelector('.dash-panel-head')!, 'offsetParent', { value: null, configurable: true });
    Object.defineProperty(document.getElementById('ajax-status')!.parentElement!, 'offsetParent', { value: null, configurable: true });
    const orders = document.getElementById('dash-panel-orders')!;
    makeVisible(orders, orders.querySelector('.dash-panel-head'));

    showStatus('second');
    expect(document.getElementById('ajax-status')!.previousElementSibling?.textContent).toBe('B');
  });
});

/**
 * The half that rots without any test failing: JS anchoring to a class the markup stopped
 * rendering. `.products-header` lived on in `dashboard.css` long after nothing rendered it, which
 * is why reading the stylesheet would not have revealed the bug either — only the MARKUP counts.
 */
describe('dashboard scripts anchor to classes the markup actually renders', () => {
  const MARKUP_DIRS = ['src/pages', 'src/components', 'src/layouts'];
  /** Classes written by scripts at runtime rather than rendered by a template. */
  const RUNTIME_ONLY = new Set(['ajax-status', 'dash-error', 'dash-success']);

  function walk(dir: string, test: RegExp, out: string[] = []): string[] {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return out; }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, test, out);
      else if (test.test(path)) out.push(path);
    }
    return out;
  }

  it('has no querySelector class that no template renders', () => {
    // A script rendering its own markup with `innerHTML` is a perfectly good source of a class —
    // `orders.ts` both writes and queries `.order-note-del-yes`. So the corpus is everything, and
    // what is REMOVED from it is every `querySelector` argument: a class that appears only inside
    // a query is a class nothing renders, which is exactly the failure being hunted. Without this
    // subtraction the test proves only that the string appears somewhere, which it always does.
    const QUERY = /querySelector(?:All)?\(\s*'[^']*'/g;
    const corpus = [
      ...MARKUP_DIRS.flatMap((d) => walk(d, /\.astro$/)),
      ...walk('src/scripts', /\.ts$/),
      // `src/lib` builds markup too — `chart-svg.ts` emits the chart's `.line-dot`, and
      // `order-invoice-row.ts` the invoice chip — so a corpus without it reports classes that are
      // rendered on every page load.
      ...walk('src/lib', /\.ts$/),
    ].map((f) => readFileSync(f, 'utf8').replace(QUERY, '')).join('\n');

    const missing: string[] = [];
    for (const file of walk('src/scripts/dashboard', /\.ts$/)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/querySelector(?:All)?\(\s*'\.([a-zA-Z0-9_-]+)'/g)) {
        const cls = m[1]!;
        if (RUNTIME_ONLY.has(cls)) continue;
        if (!new RegExp(`[\\s"'\`.]${cls}[\\s"'\`:,)]`).test(corpus)) missing.push(`${file}  →  .${cls}`);
      }
    }
    expect(missing, [
      'A dashboard script queries a CSS class that no template renders.',
      'The query returns null, `?.` swallows it, and the feature does nothing — silently, in the',
      "seller's browser. This is how the status banner went missing for 56 call sites.",
      '',
      ...missing,
    ].join('\n')).toEqual([]);
  });
});
