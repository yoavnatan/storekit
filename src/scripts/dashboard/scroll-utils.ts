// Shared JS-computed smooth scroll for the dashboard.
//
// Measured (not theoretical) on this RTL site: the browser's own native CSS
// smooth-scroll (`scroll-behavior:smooth` + `window.scrollTo({top, behavior:
// 'smooth'})`) visibly nudges window.scrollX away from 0 mid-animation and back
// — a diagonal jump — for a `top`-only scrollTo on a tall RTL document. Neither
// pinning `left` explicitly on the same call, nor a same-thread rAF loop forcing
// scrollX back to 0 every frame, stops it — the native animation runs off the
// main thread in a way that races both. The reliable fix is to not delegate to
// native smooth-scroll at all: animate scrollY ourselves and call the positional
// (always-instant, both-axes-explicit) `window.scrollTo(x, y)` every frame.
// (AI_INSTRUCTIONS → Architecture → Scroll.) `html` keeps `scrollbar-gutter:stable` +
// `overflow-x:hidden` in reset.css.
//
// The other half of "where do I scroll TO", moved here 2026-07-31: the SELLER DASHBOARD STACKS
// THREE STICKY LAYERS that a JS scroll target has to clear — the fixed site header
// (`--site-header-h`), the sticky tab strip (`--dash-tabs-h`), and the sticky `.dash-panel-head`,
// which has no CSS var and must be measured live. Forget the panel head and the target lands
// hidden underneath it, which looks like the scroll simply failed.
// `onDone` runs once the last frame has landed (and immediately on the no-op
// path, so a caller can rely on it firing exactly once either way). It exists
// for callers that hold something open for the duration of the scroll — the
// homepage freezes the page height across a tab switch so the swap can't yank
// the scroll position, and releases it here.
/** How many animations currently hold the root's `scroll-behavior` at `auto`. */
let running = 0;

export function animateScrollTo(targetY: number, duration = 380, onDone?: () => void): void {
  const startY = window.scrollY;
  const delta = targetY - startY;
  const root = document.documentElement;
  // `reset.css` sets `scroll-behavior: smooth` on the root, and that applies to
  // the POSITIONAL `scrollTo(x, y)` too — so every frame below was asking the
  // browser to smoothly animate toward a target ~3px away, and each request
  // restarted that easing. The result was a crawl: measured 2px per frame, ~40px
  // of travel across a whole 380ms "animation" that was supposed to cover 1200px
  // (2026-07-30). This function existed precisely to keep the browser's own
  // animator out of it, and could not, silently. Turning the property off for the
  // duration is what makes each frame's write land where it was put — and it is
  // also what finally makes the RTL drift this file was written for impossible,
  // rather than merely unlikely.
  root.style.scrollBehavior = 'auto';
  running += 1;
  // Counted, not a plain clear: two overlapping calls would otherwise have the
  // first one to finish hand the root back to `smooth` mid-flight, and the
  // second would spend its remaining frames crawling again.
  const settle = (): void => {
    running -= 1;
    if (running === 0) root.style.scrollBehavior = '';
    onDone?.();
  };
  if (Math.abs(delta) < 1) { window.scrollTo(0, targetY); settle(); return; }
  const start = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3); // ease-out cubic, matches the site's other spring/ease timings in spirit

  function step(now: number) {
    const t = Math.min(1, (now - start) / duration);
    window.scrollTo(0, startY + delta * ease(t));
    if (t < 1) requestAnimationFrame(step);
    else settle();
  }
  requestAnimationFrame(step);
}

/** Scroll a products-tab panel (CSV import, external-inventory sync) so its top sits just below the
 *  three stacked sticky layers — fixed site header (--site-header-h) + sticky tab strip
 *  (--dash-tabs-h) + the sticky products toolbar (--products-toolbar-h). Plain scrollIntoView ignores
 *  those, landing the panel's title hidden beneath the pinned toolbar when the user opens it from far
 *  down the list. Mirrors advertising.ts's boost-jump offset math. */
export function scrollProductsPanelIntoView(el: HTMLElement): void {
  const rootStyle = getComputedStyle(document.documentElement);
  const remPx = parseFloat(rootStyle.fontSize) || 16;
  const toPx = (v: string, fallback: number): number => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return v.trim().endsWith('rem') ? n * remPx : n;
  };
  const headerH = toPx(rootStyle.getPropertyValue('--site-header-h'), 3.3 * remPx);
  const tabsH = toPx(rootStyle.getPropertyValue('--dash-tabs-h'), 2.9 * remPx);
  const toolbarH = toPx(rootStyle.getPropertyValue('--products-toolbar-h'), 3.4 * remPx);
  const stack = headerH + tabsH + toolbarH;
  const rectTop = el.getBoundingClientRect().top;
  // Only scroll when the panel's TOP is actually hidden — tucked under the sticky stack (scrolled
  // past it) or below the fold. If it's already visible in the viewport (e.g. the user was near the
  // top of the list), leave the scroll position alone rather than yanking the page down.
  if (rectTop >= stack && rectTop < window.innerHeight) return;
  const margin = 0.5 * remPx; // small breathing room below the pinned toolbar
  animateScrollTo(Math.max(0, rectTop + window.scrollY - stack - margin));
}
