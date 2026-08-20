/**
 * The measured heights of the bars a dashboard pins things under.
 *
 * Four sticky `top:` rules and two scroll-offset calculations are written as
 * `calc(var(--site-header-h, 3.3rem) + var(--dash-tabs-h, 2.9rem) + …)`. Those fallbacks are
 * guesses, and the real bars are not the guessed heights — the site header measures 54.39px against
 * a 52.8px fallback, the tab strip 45.18px against 46.4px — so a tree that never runs this pins
 * every bar a pixel or two off its neighbour. A fraction of a pixel of daylight between two pinned
 * bars is not invisible: the page scrolls behind it, so it reads as a moving seam rather than as a
 * misaligned edge (owner has now reported this shape twice).
 *
 * **It lives in its own module because it has two dashboards to serve.** It was written inside
 * `products.ts`, which is the seller dashboard's ~61KB bundle — so the admin dashboard could not
 * call it without importing all of that, and the admin's own tab strip therefore ran on the
 * fallbacks. Nothing here touches products, or the seller, or the DOM beyond three `getBoundingClientRect`
 * reads and three custom properties.
 *
 * `getBoundingClientRect` (fractional) and not `offsetHeight` (rounds to whole pixels): the rounding
 * alone was enough to leave the 1-2px seam this exists to close.
 */
export function initStickyOffsets(): void {
  const root = document.documentElement;
  const siteHeader = document.querySelector<HTMLElement>('.site-header');
  const tabs = document.querySelector<HTMLElement>('.dash-tabs');
  const toolbar = document.querySelector<HTMLElement>('.products-header');
  if (!siteHeader && !tabs && !toolbar) return;

  const updateHeaderH = () => { if (siteHeader) root.style.setProperty('--site-header-h', `${siteHeader.getBoundingClientRect().height}px`); };
  const updateTabsH = () => { if (tabs) root.style.setProperty('--dash-tabs-h', `${tabs.getBoundingClientRect().height}px`); };
  const updateToolbarH = () => { if (toolbar) root.style.setProperty('--products-toolbar-h', `${toolbar.getBoundingClientRect().height}px`); };

  updateHeaderH();
  updateTabsH();
  updateToolbarH();

  if (typeof ResizeObserver !== 'undefined') {
    if (siteHeader) new ResizeObserver(updateHeaderH).observe(siteHeader);
    if (tabs) new ResizeObserver(updateTabsH).observe(tabs);
    if (toolbar) new ResizeObserver(updateToolbarH).observe(toolbar);
  } else {
    window.addEventListener('resize', () => { updateHeaderH(); updateTabsH(); updateToolbarH(); });
  }
}
