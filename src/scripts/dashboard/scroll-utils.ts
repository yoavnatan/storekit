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
// The other half of "where do I scroll TO", moved here 2026-07-31: EVERY PAGE has the fixed site
// header covering the top of the viewport, and the SELLER DASHBOARD STACKS TWO MORE STICKY LAYERS
// under it — the tab strip and the open panel's sticky head. Forget them and the target lands
// hidden underneath, which looks like the scroll simply failed (or overshot). `pinnedTopChrome` /
// `scrollBelowPinnedChrome` below own that math for all of them; nothing should re-derive it.
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

/** Total height of the bars this site pins to the TOP of the viewport above `el`, measured live in
 *  the DOM rather than read from CSS vars (`--site-header-h` and friends are only ever *referenced*
 *  with fallbacks — nothing defines them, so a var read is really a guess).
 *
 *  Everywhere: the site header is `position:fixed` (components/header.css), so it covers the top of
 *  the viewport on every page. On the seller dashboard two more layers stack under it — the sticky
 *  tab strip and the open panel's own sticky head (`.dash-panel-head`, or `.products-header` on the
 *  products tab). A closed panel carries `hidden`, so its head measures 0 and drops out by itself.
 *
 *  A bar only counts while it is ACTUALLY pinned: dashboard.css deliberately drops
 *  `.products-header` (and the table's own column headers) to `position:static` while an edit row is
 *  open, so that only the edit row's header stays pinned. Reading the computed position keeps this
 *  function honest about that instead of adding phantom height for a bar that scrolls away. */
export function pinnedTopChrome(el: HTMLElement): number {
  const barH = (sel: string, root: ParentNode): number => {
    const bar = root.querySelector<HTMLElement>(sel);
    if (!bar) return 0;
    const pos = getComputedStyle(bar).position;
    return pos === 'sticky' || pos === 'fixed' ? bar.getBoundingClientRect().height : 0;
  };
  let stack = barH('.site-header', document);
  const dash = el.closest('.seller-dash');
  if (dash) {
    stack += barH('.dash-tabs', dash);
    const panel = el.closest<HTMLElement>('.dash-panel');
    if (panel) stack += barH('.dash-panel-head', panel) + barH('.products-header', panel);
  }
  return stack;
}

/** Scroll `el` to just BELOW that pinned chrome. This is the replacement for
 *  `scrollIntoView({block:'start'})`, which parks the target's top edge at viewport top — i.e.
 *  underneath the fixed header — so the thing you scrolled to (a section heading, the first row of a
 *  new page of results) lands hidden and the scroll reads as having overshot. Reported on checkout:
 *  opening the payment accordion left "פרטי תשלום" behind the header (2026-08-01).
 *
 *  `edge: 'bottom'` parks the element's BOTTOM at the chrome line instead — "scroll just PAST this",
 *  used when the thing above the target would otherwise peek out as a sliver under the header. The
 *  whitespace the layout already puts between them becomes the breathing room, so pair it with
 *  margin 0. Ceiled, so a fractional rect can't leave a hairline of that element showing. */
export function scrollBelowPinnedChrome(el: HTMLElement, margin = 12, edge: 'top' | 'bottom' = 'top'): void {
  const rect = el.getBoundingClientRect();
  const y = (edge === 'bottom' ? rect.bottom : rect.top) + window.scrollY - pinnedTopChrome(el) - margin;
  animateScrollTo(Math.max(0, Math.ceil(y)));
}

/** Scroll a products-tab panel (CSV import, external-inventory sync) so its top sits just below the
 *  sticky stack, but ONLY when it is actually hidden. */
export function scrollProductsPanelIntoView(el: HTMLElement): void {
  const rectTop = el.getBoundingClientRect().top;
  // If the panel's top is already visible in the viewport (e.g. the user was near the top of the
  // list), leave the scroll position alone rather than yanking the page down.
  if (rectTop >= pinnedTopChrome(el) && rectTop < window.innerHeight) return;
  animateScrollTo(Math.max(0, rectTop + window.scrollY - pinnedTopChrome(el) - 8));
}
