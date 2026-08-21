/**
 * The pinned banner must stop being pinned once the curtain has covered it.
 *
 * The bug (owner, 2026-08-21): "the image behind the curtain is partially revealed while
 * scrolling" — deep in the page, on a fast scroll, at desktop widths, on every store. What made it
 * possible for the whole length of the page is that `.store-banner-pin`'s containing block was the
 * page wrapper, so the banner never finished: it stayed live under the header, in its own
 * compositor layer, from the first product row to the footer, invisible only because everything
 * scrolling over it happens to be opaque. A compositor is allowed to draw that layer a frame out
 * of step with the content on top of it, and no z-index answers that.
 *
 * `.store-banner-pinwrap` bounds the travel instead. The curtain needs to cover the pin exactly
 * once; after that the pin scrolls away like anything else and there is no live sticky layer left.
 * Measured on the real page: the curtain finishes covering at y=460 (1400px wide) and the pin
 * releases at y=560, with the rendering pixel-identical to before at every offset tested, both
 * widths, including straight through the release.
 *
 * Three things are guarded, because each one is silent when it breaks:
 *
 *  1. **The travel is HEIGHT, never padding.** Blink measures the sticky range against the
 *     containing block's CONTENT box. A `padding-bottom` here buys zero travel, so the pin stops
 *     pinning at all and the curtain scroll disappears — the first attempt at this fix did exactly
 *     that, and nothing failed. Same reason the give-back margin is on the curtain and not on the
 *     wrapper: a negative bottom margin here takes the travel back out of the constraint rect.
 *
 *  2. **The give-back matches the travel**, or the page grows a screenful of blank.
 *
 *  3. **The travel still exceeds the pin.** The pin is `--max-width`/3 (a fixed 3:1 image in the
 *     container) plus its 2.5rem of padding. Raise `--max-width` and a fixed travel silently
 *     becomes too small — the banner would start sliding away while still half uncovered, which
 *     reads as the curtain being broken rather than as a number being stale.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const STORE_CSS = read('../src/styles/pages/store.css');
const STORE_PAGE = read('../src/pages/[storeSlug]/index.astro');
const TOKENS = read('../src/styles/base/tokens.css');

/** Strip comments so this file's prose, and the CSS's own, can never satisfy a match. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

const CSS = code(STORE_CSS);

/** The one number: how far the pin may travel before it lets go, in rem. */
function travelRem(): number {
  const after = /\.store-banner-pinwrap::after\s*\{([^}]*)\}/.exec(CSS);
  expect(after, '.store-banner-pinwrap::after missing — the pin has no bounded travel').not.toBeNull();
  expect(after![1], 'the ::after must be an in-flow block, or it contributes no height').toMatch(/display:\s*block/);
  const h = /height:\s*([\d.]+)rem/.exec(after![1]);
  expect(h, 'the travel must be a plain rem height — see the padding note above').not.toBeNull();
  return Number(h![1]);
}

describe('the pinned banner is released once it is covered', () => {
  it('every .store-banner-pin in the markup sits inside .store-banner-pinwrap', () => {
    const markup = code(STORE_PAGE);
    const pins = markup.match(/class="store-banner-pin"/g) ?? [];
    expect(pins.length, 'expected the two banner branches (showcase and uploaded)').toBe(2);
    const wrapped = markup.match(/class="store-banner-pinwrap"\s*>\s*<div class="store-banner-pin"/g) ?? [];
    expect(wrapped.length, 'a .store-banner-pin is not directly inside .store-banner-pinwrap').toBe(pins.length);
  });

  it('the travel is content-box height, not padding', () => {
    const rem = travelRem();
    expect(rem).toBeGreaterThan(0);
    // Padding on the wrapper is the trap, not a second way of doing it.
    const wrapper = /\.store-banner-pinwrap\s*\{([^}]*)\}/.exec(CSS);
    if (wrapper) expect(wrapper[1]).not.toMatch(/padding-bottom|margin-bottom/);
  });

  it('the height is given back to the layout, exactly', () => {
    const give = /\.store-banner-pinwrap\s*\+\s*\.store-banner\s*\{([^}]*)\}/.exec(CSS);
    expect(give, 'nothing pulls .store-banner back up — the page would grow by the travel').not.toBeNull();
    const m = /margin-top:\s*-([\d.]+)rem/.exec(give![1]);
    expect(m, 'expected a negative rem margin-top').not.toBeNull();
    expect(Number(m![1])).toBe(travelRem());
  });

  it('the travel still outlasts the pin at the widest the container can get', () => {
    const max = /--max-width:\s*(\d+)px/.exec(code(TOKENS));
    expect(max, '--max-width not found in tokens.css').not.toBeNull();
    // Pin height = the 3:1 image at container width, plus 1.25rem of padding top and bottom.
    const pinRem = Number(max![1]) / 3 / 16 + 2.5;
    expect(travelRem(), `travel must exceed the pin's own height (${pinRem.toFixed(1)}rem)`).toBeGreaterThan(pinRem);
  });

  it('the pin is still sticky and still pinned to the header line', () => {
    // The release is the fix; the pinning is the feature. Dropping the sticky to "solve" the
    // reveal would take the curtain scroll with it.
    const block = /\.store-banner-pin\s*\{([^}]*)\}/.exec(CSS);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/position:\s*sticky/);
    expect(block![1]).toMatch(/top:\s*var\(--site-header-h/);
  });
});
