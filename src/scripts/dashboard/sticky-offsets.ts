/**
 * The measured heights of the bars a dashboard pins things under.
 *
 * Four sticky `top:` rules and two scroll-offset calculations are written as
 * `calc(var(--site-header-h, 3.3rem) + var(--dash-tabs-h, 2.9rem) + …)`. Those fallbacks are
 * guesses, and the real bars are not the guessed heights — the site header measures 54.39px against
 * a 52.8px fallback, the tab strip 45.17px against 46.4px. **A tree that never runs this pins the
 * panel title 1.2px below the strip above it**, and 1.2px of daylight between two pinned bars is
 * not a misaligned edge: the page scrolls through it, so it reads as a moving line (owner, סשן ד׳:
 * *"רווח קטן למעלה שכשגוללים רואים תוכן שעובר מאחורה"*). That is what it looked like for a year on
 * every seller tab except Products, because the only call site was inside the products panel's
 * loader. Both dashboards now call it at page load.
 *
 * **It lives in its own module because it has two dashboards to serve.** It was written inside
 * `products.ts`, which is the seller dashboard's ~61KB bundle — so the admin dashboard could not
 * call it without importing all of that, and the admin's own tab strip therefore ran on the
 * fallbacks. Nothing here touches products, or the seller, or the DOM beyond three
 * `getBoundingClientRect` reads and three custom properties.
 *
 * `getBoundingClientRect` (fractional) and not `offsetHeight` (rounds to whole pixels): the
 * rounding alone was enough to leave the 1-2px seam this exists to close.
 *
 * **Safe to call more than once.** The seller dashboard calls it again once the products panel's
 * HTML has arrived, because `.products-header` lives inside that panel and does not exist at load;
 * a bar this has already measured is not observed twice.
 */

/** A bar whose box is currently zero — a panel that has not been opened yet — must NOT overwrite
 *  its var with `0px`. `0px` is a value, so it beats the fallback in `var(--x, 3.4rem)` and pins
 *  the thing below it right under the site header until the panel opens. Removing the property
 *  instead hands the question back to the CSS fallback, which is what the fallback is for. */
function writeBar(root: HTMLElement, prop: string, el: HTMLElement): void {
  const h = el.getBoundingClientRect().height;
  if (h > 0) root.style.setProperty(prop, `${h}px`);
  else root.style.removeProperty(prop);
}

const observed = new WeakSet<HTMLElement>();

function watch(root: HTMLElement, prop: string, el: HTMLElement | null): void {
  if (!el) return;
  writeBar(root, prop, el);
  if (observed.has(el)) return;
  observed.add(el);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => writeBar(root, prop, el)).observe(el);
  } else {
    window.addEventListener('resize', () => writeBar(root, prop, el));
  }
}

export function initStickyOffsets(): void {
  const root = document.documentElement;
  watch(root, '--site-header-h', document.querySelector<HTMLElement>('.site-header'));
  watch(root, '--dash-tabs-h', document.querySelector<HTMLElement>('.dash-tabs'));
  watch(root, '--products-toolbar-h', document.querySelector<HTMLElement>('.products-header'));
}
