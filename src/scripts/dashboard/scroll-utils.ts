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
// (AI_INSTRUCTIONS → Architecture → Scroll.)
export function animateScrollTo(targetY: number, duration = 380): void {
  const startY = window.scrollY;
  const delta = targetY - startY;
  if (Math.abs(delta) < 1) { window.scrollTo(0, targetY); return; }
  const start = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3); // ease-out cubic, matches the site's other spring/ease timings in spirit

  function step(now: number) {
    const t = Math.min(1, (now - start) / duration);
    window.scrollTo(0, startY + delta * ease(t));
    if (t < 1) requestAnimationFrame(step);
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
