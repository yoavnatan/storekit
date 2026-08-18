/**
 * The store page's curtain shadow must be driven by the CURTAIN, not by a proxy for it.
 *
 * The bug (owner, 2026-08-12). `.store-banner` — the white details layer that scrolls up over
 * the pinned banner image — carries `--shadow-bar-up` so its leading edge is visible while it
 * travels over an identically-white surface. It was switched on by `.site-header.is-stuck`,
 * i.e. "the page has moved by one pixel", which is the same instant the curtain starts covering
 * ONLY when the pinned banner is the first thing on the page. Two bars break that, both in normal
 * flow above the pin so they scroll away first: OwnerStoreBar (the seller viewing their own store)
 * and StoreDemoBar (a showcase store) — and on a showcase store the seller owns, both at once.
 * On those pages the shadow appeared during the first ~3rem of scroll, while the curtain had not
 * begun to move and was covering nothing: a seam under nothing, exactly the false gap the header's
 * own at-rest shadow was deleted for on 2026-08-01.
 *
 * The fix is to ask the pin. `.store-banner-pin.is-stuck` means the pinned image has reached its
 * own `top`, which is the frame the details layer begins travelling over it — true by construction
 * whatever ends up above it, and false when there is no pin at all (a store with no banner image
 * renders none, so there is no curtain and correctly no shadow).
 *
 * What this guards is the JOIN, which is where it can silently rot: the class in the CSS selector,
 * the element the JS observes, and the trigger line matching the pin's own `top`. Break any one and
 * nothing errors — the shadow just never appears again, or appears at the wrong moment, and only a
 * human scrolling a store page on the right kind of account would ever notice.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STORE_CSS = readFileSync(fileURLToPath(new URL('../src/styles/pages/store.css', import.meta.url)), 'utf8');
const STORE_PAGE = readFileSync(fileURLToPath(new URL('../src/pages/[storeSlug]/index.astro', import.meta.url)), 'utf8');
const STICKY_BAR = readFileSync(fileURLToPath(new URL('../src/lib/sticky-bar.ts', import.meta.url)), 'utf8');
const HEADER = readFileSync(fileURLToPath(new URL('../src/components/Header.astro', import.meta.url)), 'utf8');
const BOOT = readFileSync(fileURLToPath(new URL('../src/components/StickyGlassBoot.astro', import.meta.url)), 'utf8');

/** Strip /* … *\/ comments so this file's own prose — which quotes the old selector — never counts. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

describe('curtain shadow fires only while the curtain is covering', () => {
  const css = code(STORE_CSS);
  const page = code(STORE_PAGE);

  it('the shadow rule keys off the pinned banner', () => {
    const rule = css.match(/^body:has\(([^)]*)\)\s*\.store-banner\s*\{[^}]*\}/m);
    expect(rule, 'the `body:has(…) .store-banner { box-shadow }` rule has moved or changed shape — re-read this file').not.toBeNull();
    expect(rule![1].trim()).toBe('.store-banner-pin.is-stuck');
    expect(rule![0]).toContain('--shadow-bar-up');
  });

  it('nothing drives that shadow off the header, which is not the curtain', () => {
    expect(css).not.toContain('.site-header.is-stuck');
  });

  it('the markup arms .is-stuck on the element the CSS names', () => {
    // `.store-banner-pin`, NOT `.store-banner`: the details layer crosses the header line
    // long after it has finished covering the pin, so keying on it would show the shadow
    // only once the curtain's job was already done.
    //
    // Declared on the element as `data-sticky-glass` since 2026-08-18 and armed by the inline
    // <StickyGlassBoot />, rather than called from this page's module — which is why the
    // assertion is on the MARKUP now. The reason for the move is in that component; what
    // matters here is unchanged: the class lands on the pin, at the pin's own offset.
    expect(page).toMatch(/class="store-banner-pin"\s+data-sticky-glass="3\.4"/);
    expect(page, 'the pin is rendered somewhere without arming its observer')
      .not.toMatch(/class="store-banner-pin"(?!\s+data-sticky-glass)/);
    expect(page, 'the old, dead observer on the details layer is back')
      .not.toMatch(/class="store-banner"\s+data-sticky-glass/);
  });

  it('the boot that arms it is inline, not part of the page module graph', () => {
    // The whole point of the 2026-08-18 move: the bar pins on the first pixel of scroll whether
    // the page's imports have arrived or not, so the thing that dresses it may not wait on them.
    // A regression here is silent — the glass simply stops appearing on slow loads.
    expect(BOOT).toContain('is:inline');
    expect(BOOT).toContain('data-sticky-glass');
    expect(code(STORE_PAGE), 'the page module is arming the bar again — that is the bug')
      .not.toContain('initStickyBar');
  });

  it('the trigger line matches the pin\'s own top, or the shadow starts at the wrong pixel', () => {
    const pin = css.match(/\.store-banner-pin\s*\{[^}]*\}/);
    expect(pin, '.store-banner-pin rule not found').not.toBeNull();
    // Both halves read 3.4rem: sticky `top` in the CSS, rootMargin in the JS call above.
    // `--site-header-h` is set only on the dashboard, so on a store page the fallback is
    // the live value — if that ever changes, both numbers have to move together.
    expect(pin![0]).toMatch(/top:\s*var\(--site-header-h,\s*3\.4rem\)/);
  });

  it('the header no longer carries .is-stuck, since nothing reads it', () => {
    // Deleted with its last reader, 2026-08-12. It set the class on every page in the site.
    expect(code(STICKY_BAR)).not.toContain('initHeaderScrolled');
    expect(code(HEADER)).not.toContain('initHeaderScrolled');
  });
});
