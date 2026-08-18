/**
 * Pinned-panel chrome that has to be measured rather than declared.
 *
 * **The sticky-bar half of this file is GONE (2026-08-18) — `initStickyBar` and
 * `STICKY_HEADER_REM` moved into `components/StickyGlassBoot.astro`, and were not
 * reimplemented on the way.** They toggled `.is-stuck` on a pinning bar, which is what fades
 * in the store's frosted-glass backdrop. The mechanism was right; the PLACE was not. Called
 * from each page's own `<script>`, it could only run once that page's whole import graph had
 * downloaded — while the bar, being CSS, pins on the first pixel of scroll regardless. That
 * gap is why the glass "sometimes didn't load". The boot component carries the measurement
 * and the replacement; do not add a module-level version back here to call beside it.
 */

/** Overflow smaller than this is layout rounding, not content — see initOverflowShadow. */
const NOISE_FLOOR_PX = 4;

/**
 * Toggles `.overflow-shadow` on a pinned panel footer, but only while content is
 * actually hidden behind it.
 *
 * Third instance of the one rule: a shadow means something is underneath. Both
 * product modals had theirs painted unconditionally, so a modal whose content
 * fits — no scrollbar, nothing behind the footer at all — still drew a seam
 * across itself (user, 2026-08-01). The footer's own border already divides the
 * two regions; the shadow is specifically the "there is more below" signal.
 *
 * Listeners rather than a sentinel + IntersectionObserver (the trick the two
 * functions below use): a modal replaces its body with innerHTML on every open,
 * which would discard an injected sentinel. Scroll gives the position, and the
 * two observers cover the ways the answer changes without a scroll — the panel
 * resizing, and the content being swapped for a different product.
 */
export function initOverflowShadow(scroller: HTMLElement | null, footer: HTMLElement | null): void {
  if (!scroller || !footer) return;
  const sync = () => {
    const total = scroller.scrollHeight - scroller.clientHeight;
    // A few pixels of overflow is never content — it is sub-pixel rounding out of
    // the flex/aspect-ratio layout, and it varies with zoom and DPR, so chasing
    // the one element that produced it fixes nothing at 110%. Below the noise
    // floor the panel simply does not scroll: a product whose description is two
    // lines long offered a scroll that moved 2-3 empty pixels, which reads as
    // broken rather than as "nothing here" (user, 2026-08-01). One line of real
    // text is 16px+, so nothing legible can hide under this threshold.
    scroller.style.overflowY = total > NOISE_FLOOR_PX ? 'auto' : 'hidden';
    const hiddenBelow = total - scroller.scrollTop > NOISE_FLOOR_PX;
    footer.classList.toggle('overflow-shadow', hiddenBelow);
  };
  scroller.addEventListener('scroll', sync, { passive: true });
  new ResizeObserver(sync).observe(scroller);
  new MutationObserver(sync).observe(scroller, { childList: true, subtree: true });
  sync();
}
