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
    // A bar does not cover ITSELF, nor anything it contains. Without this, `scrollEditRowIntoView`
    // — which scrolls to `.edit-row-header`, a bar counted below — would land the form's own header
    // exactly its own height too low the moment that header is pinned. Every existing caller either
    // targets something none of these bars contain (unchanged) or targets a bar itself (which is
    // what today's behaviour already is, because the bar was not in the stack at all).
    if (bar === el || bar.contains(el)) return 0;
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
  // The open product form's own header (Save / Cancel), which is `position:sticky` at 640px and
  // below — the phone-only rule in dashboard.css. It is the LAST bar above anything inside that
  // form, and the guard above keeps it from counting for the header itself.
  const editRow = el.closest<HTMLElement>('tr.edit-row');
  if (editRow) stack += barH('.edit-row-header', editRow);
  // The products table's column headings are sticky too, and they are the LAST bar in the stack —
  // but only for a target inside that table. Counted unconditionally they would over-scroll every
  // target that sits ABOVE it (the CSV and feed-sync panels both do), leaving a gap instead of
  // landing flush. Matters since 2026-08-04, when the headings stopped unsticking for an open edit
  // row: without this, clicking "edit" parked the form's own header — with its Save button —
  // underneath them.
  const table = el.closest<HTMLElement>('#products-table');
  if (table) stack += barH('thead th', table);
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

/**
 * Bring `el` back below the pinned chrome, but ONLY if it is not already fully on screen.
 *
 * For a row that REPLACES something taller than itself — the products table's edit form closing
 * back to its one-line display row. The form is tall, the seller scrolls down inside it to reach
 * the save button, and when it collapses the row they just saved is left far above the viewport:
 * the page appears to jump to an unrelated part of the list, with no confirmation of the thing that
 * was saved. Measured AFTER the tall row is hidden, so the rect is the post-collapse one.
 *
 * The visibility test is "fully inside the band", not "partly", because a row is short and a sliver
 * of it under the header is exactly the state being complained about. When it IS fully visible this
 * does nothing at all — a save that changes nothing on screen must not move the page
 * (AI_INSTRUCTIONS → no-op interactions must be invisible).
 */
export function scrollRowBackIntoView(el: HTMLElement, margin = 12): void {
  const rect = el.getBoundingClientRect();
  const top = pinnedTopChrome(el);
  if (rect.top >= top && rect.bottom <= window.innerHeight) return;
  animateScrollTo(Math.max(0, Math.ceil(rect.top + window.scrollY - top - margin)));
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


/**
 * Teach the BROWSER'S OWN scrolling about the bars this site pins over the top of the viewport.
 *
 * Everything above this line is for scrolls WE start. This is for the one nobody starts: type into
 * a field that is off the top of the screen — because you tabbed to it, or scrolled while it kept
 * focus — and the browser scrolls the caret back into view by itself, with no event to intercept
 * and no way to talk it out of the position it picks. On the seller dashboard it picks the top of
 * the viewport, which is under the site header, the tab strip, and (on the products tab) the
 * table's column headings or the open form's own Save bar. Owner, 2026-08-22: *"אני מקליד בתוך
 * האינפוטים בתוך טופס העריכה הפתוח של המוצר… זה כן גולל לאינפוט כשמקלידים אבל בגלל שיש את כל
 * הסטיקי הדרס אז האינפוט עצמו מכוסה על ידם"*.
 *
 * `scroll-padding-top` is the property that exists for exactly this: it declares that the top N
 * pixels of the scrollport are not really viewable, and every scroll-into-view the browser performs
 * — caret, focus, `:target`, `scrollIntoView` — honours it. Measured on a probe page (fixed 120px
 * bar, caret scrolled from above the fold): the field landed at y −11px without it and at y +109px
 * with it, i.e. the full bar height, out from underneath.
 *
 * **Written on focus and removed on blur, rather than set once in CSS.** The stack is not a
 * constant — it differs between the two dashboards, between the breakpoints, and between an open
 * and a closed edit row — and `pinnedTopChrome` is the one place that already knows all of that.
 * Leaving it applied would also quietly re-aim every `scrollIntoView({block:'nearest'})` on the
 * page, which is a change nobody asked for; scoped to "a text field has focus", the only scroll it
 * can affect is the caret's own.
 */
export function initCaretScrollPadding(): void {
  const root = document.documentElement;
  const FIELD = 'input, textarea, select, [contenteditable="true"]';

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.matches(FIELD)) return;
    // **The field's own top padding is part of the sum, and leaving it out lands the field back
    // under the bar by a hair.** What the browser scrolls into view is the CARET, not the box
    // around it — so the box's top edge comes to rest that much higher than the line the padding
    // draws. Measured on the harness for this fix: a `.input` (10.4px padding + 1px border) landed
    // its border-box top 13.7px above the scroll-padding line, i.e. 0.4px *under* the table's
    // column headings, which is the whole complaint again in miniature. Read off the element
    // rather than hard-coded, because a `select` and a textarea are not the same field.
    // The remaining +12 is the breathing room `scrollBelowPinnedChrome` gives its own targets.
    const cs = getComputedStyle(el);
    const inset = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
    root.style.scrollPaddingTop = `${Math.ceil(pinnedTopChrome(el) + inset) + 12}px`;
  });

  document.addEventListener('focusout', () => { root.style.removeProperty('scroll-padding-top'); });
}
