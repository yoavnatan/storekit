/**
 * The three image carousels page with CSS scroll-snap and NOTHING else.
 *
 * All three — the store grid's product card, `StoreProductModal`, `ProductQuickView` — carried the
 * same hand-written touch pager: `scrollSnapType = 'none'` on `touchstart`, then a computed
 * `scrollLeft` write on `touchend` meant to advance exactly one slide. It was wrong on every phone
 * this site is built for, and wrong in three ways at once (owner, 2026-09-02: *"או שזה לא נגלל או
 * שזה נתקע או חוזר על עצמו"*, and *"זה לא עוצר בסוף, זה ממשיך לגלול לעבר משהו לא ברור"*).
 *
 * Measured at 390px on a 4-image card, before the deletion:
 *
 *   - The strip is `direction: rtl`, where a finger moving RIGHT scrolls toward the NEXT slide.
 *     The pager read `dx < 0` (finger LEFT) as "next", so it moved the carousel against the finger.
 *   - Swiping the natural way twice in a row from slide 0 left `scrollLeft` at 0 both times: the
 *     native scroll went the right way, the script ordered it back. "It doesn't scroll."
 *   - The `scrollLeft` write lands mid-fling, and the browser carries on animating past it — from
 *     slide 1 a swipe travelled to -280 and settled back on -175, the slide it started on. "It
 *     keeps going toward something unclear, the same image or the previous one."
 *   - A 15px nudge — under any sane threshold — paged a whole slide backwards.
 *
 * `scroll-snap-type: x mandatory` plus `scroll-snap-stop: always` is the platform doing all of it
 * correctly, including the one-slide-at-a-time rule the pager was written for: measured after the
 * deletion, a hard fling advances exactly one slide, in both directions, in the card and in the
 * modal. So this file guards two things, because the second is what makes the first safe:
 *
 *   1. Nobody re-introduces a touch pager (the `scrollSnapType = 'none'` that starts one).
 *   2. Every slide keeps `scroll-snap-stop: always` — without it, deleting the pager WOULD bring
 *      momentum skipping back, and that regression is invisible to every check except a phone.
 */
import { describe, it, expect } from 'vitest';
import { sourceGuard, readSource } from './helpers/source-guard.js';

/** The three files that own a horizontal image strip. */
const CAROUSEL_FILES = [
  'src/pages/[storeSlug]/index.astro',
  'src/components/StoreProductModal.astro',
  'src/components/ProductQuickView.astro',
];

/** The body of the first CSS rule whose selector line contains `selector`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? '' : css.slice(open + 1, close);
}

describe('image carousels page natively', () => {
  it('no file disables scroll-snap to hand-roll a touch pager', () => {
    for (const file of CAROUSEL_FILES) {
      sourceGuard({
        file,
        rule: 'scroll-snap is never switched off in JS — the CSS does the paging',
        find: (src) => [...src.matchAll(/scrollSnapType\s*=\s*['"`]none['"`]/g)].map((m) => m[0]),
        mustReject: "slides.style.scrollSnapType = 'none';",
      });
    }
    expect(CAROUSEL_FILES).toHaveLength(3);
  });

  it('no touchend handler writes scrollLeft', () => {
    for (const file of CAROUSEL_FILES) {
      sourceGuard({
        file,
        rule: 'a touch handler never assigns scrollLeft — that write lands mid-fling and is overrun',
        // Scoped to the SLIDE strips by name. `scrollTo({...})` is fine and is how a dot click
        // jumps; a bare assignment on a snap strip is the pager. The category chip rail's own
        // `categoryFilters.scrollLeft = 0` is a different element doing a legitimate reset.
        find: (src) => [...src.matchAll(/\w*[sS]lides\w*!?\.scrollLeft\s*=[^=]/g)].map((m) => m[0]),
        mustReject: 'slidesEl.scrollLeft = left;',
      });
    }
    expect(CAROUSEL_FILES).toHaveLength(3);
  });

  it('every slide stops the fling on itself', () => {
    // The store grid card and the product modal, from the shared stylesheet.
    const css = readSource('src/styles/pages/store.css');
    for (const selector of ['.product-card__slide {', '.pm-slide {']) {
      expect(ruleBody(css, selector), `${selector} must keep scroll-snap-stop: always`)
        .toContain('scroll-snap-stop: always');
    }
    // The quick view builds its slides with Tailwind arbitrary properties instead.
    expect(readSource('src/components/ProductQuickView.astro'))
      .toContain('[scroll-snap-stop:always]');
  });

  it('the slide rule bodies are actually being read', () => {
    // `ruleBody` returning '' for a moved selector would make the test above pass on nothing.
    expect(ruleBody(readSource('src/styles/pages/store.css'), '.product-card__slide {')).not.toBe('');
    expect(ruleBody('.x { a: b; }', '.x {')).toBe(' a: b; ');
    expect(ruleBody('.x { a: b; }', '.missing {')).toBe('');
  });
});
