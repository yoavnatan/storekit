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
