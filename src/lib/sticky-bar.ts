/**
 * Toggles `.is-stuck` on a `position:sticky` control bar the moment it pins to
 * the fixed site header — which is what fades the frosted-glass backdrop in
 * (`.store-controls::before`, styles/pages/store.css). At rest, with nothing
 * scrolling behind it, glass is meaningless; it only earns its place once cards
 * are dissolving underneath.
 *
 * A zero-height sentinel inserted just above the bar drives it through an
 * IntersectionObserver, so there is no scroll handler and no per-frame layout
 * cost. The header's height becomes the trigger line via `rootMargin`.
 *
 * Extracted from the store page so the /stores directory's own filter bar
 * behaves identically rather than reimplementing it.
 */

/** Site header height in rem — matches `.store-controls`'s own `top` and
 *  `body { padding-top }`. Kept as one number so the trigger line and the pin
 *  line can't drift apart. */
export const STICKY_HEADER_REM = 3.3;

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

/* GONE, 2026-08-12: initHeaderScrolled, which put `.is-stuck` on the site header on the
   first pixel of scroll. It stopped driving any depth on 2026-08-02 (the header has no
   shadow in any state), and its last reader was the store page's curtain shadow, which
   was using "the page has moved" as a stand-in for "the curtain is covering something".
   Those are only the same moment when nothing sits above the pinned banner, so the shadow
   now keys off `.store-banner-pin.is-stuck` — the pin itself — and this observer was left
   running on every page in the site to set a class nobody read. Don't reintroduce it to
   answer "has the page scrolled": ask the element that cares whether IT has pinned. */

export function initStickyBar(bar: HTMLElement | null, headerRem: number = STICKY_HEADER_REM): void {
  if (!bar?.parentElement) return;
  const sentinel = document.createElement('div');
  sentinel.setAttribute('aria-hidden', 'true');
  bar.parentElement.insertBefore(sentinel, bar);
  const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize || '16');
  const headerPx = Math.round(headerRem * rootFontPx);
  new IntersectionObserver(
    ([entry]) => bar.classList.toggle('is-stuck', !entry?.isIntersecting),
    { rootMargin: `-${headerPx}px 0px 0px 0px`, threshold: 0 },
  ).observe(sentinel);
}
