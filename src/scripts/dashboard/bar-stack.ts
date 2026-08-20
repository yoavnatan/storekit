/**
 * The dashboard's floating notices, packed against the bottom edge.
 *
 * Three bars can be out at once — "you have unsaved changes" (UnsavedChangesBar), "there is work
 * from last time waiting" (FormFallbackGuard) and "another tab changed this store" (StaleDataBar).
 * Each used to place ITSELF at a fixed offset chosen so that no two could land on top of each
 * other: bottom-6, bottom-[5.5rem], and bottom-6-or-9.5rem depending on whether either of the
 * others was showing. That arithmetic is only correct when every slot below a bar is occupied, and
 * the common case is that they are not — the draft bar stepping over BOTH reserved slots while only
 * the lower one was filled left a bar's worth of empty air in the middle of the stack (owner,
 * סשן א׳ §3: *"לפעמים הן מופיעות עם רווח משמעותי אחת מהשניה... זה מאוד לא נוח ומפריע לעבודה"*).
 *
 * So the offsets are computed instead of reserved: the visible bars are laid out bottom-up in one
 * fixed priority order, each one starting where the previous ended. A hidden bar occupies nothing,
 * which is the whole difference, and a bar that grows a second line pushes the ones above it
 * rather than being overlapped by them.
 *
 * **Why a module and not a flex container.** The natural shape — one `position:fixed` column with a
 * gap — would take `position` off the bars themselves, and the elevation guard
 * (tests/design-shadow-rule.test.ts) deliberately requires the element CASTING a shadow to declare
 * that it floats; an ancestor cannot vouch for it. Each bar therefore stays `fixed` and keeps its
 * own shadow honest, and this owns only the number.
 *
 * Every bar keeps `bottom-6` in its markup as the resting value, which is also the answer when this
 * module never arrives: the only bar that can appear on a dead module graph is the draft one
 * (FormFallbackGuard is inline precisely so it survives that), and alone at the bottom is exactly
 * where it belongs.
 */

/** Bottom-up. Most actionable nearest the thumb; the advisory "this data is stale" on top. */
const ORDER = ['dash-unsaved-bar', 'dash-draft-bar', 'dash-stale-bar'];

/** `bottom-6` and the gap between two bars, in px — the resting offset the markup already carries. */
const EDGE = 24;
const GAP = 12;

/** A bar is out when it is not carrying the `!hidden` utility every one of them is toggled with. */
function visible(el: HTMLElement): boolean {
  return !el.classList.contains('!hidden');
}

export function layoutDashBars(): void {
  let offset = EDGE;
  for (const id of ORDER) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Back to the markup's own value, so a bar that is put away leaves no stale inline offset for
    // the next time it appears — by which point the stack under it may be a different height.
    if (!visible(el)) { el.style.bottom = ''; continue; }
    el.style.bottom = `${offset}px`;
    offset += el.getBoundingClientRect().height + GAP;
  }
}

export function initDashBarStack(): void {
  const bars = ORDER.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
  if (!bars.length) return;
  // Driven by observation rather than by a call from each bar's owner: the three are raised by three
  // unrelated modules (one of them inline and outside the bundle), and a stack that has to be
  // notified is a stack that goes wrong the day a fourth notice is added. `class` is how every one
  // of them appears and disappears; the subtree watch is for the sentence changing length, since a
  // bar that wraps to two lines is a taller bar.
  const observer = new MutationObserver(() => layoutDashBars());
  for (const el of bars) {
    observer.observe(el, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true, characterData: true });
  }
  // Writing `style.bottom` is not observed (the filter is `class` alone), so the callback above
  // cannot re-trigger itself.
  window.addEventListener('resize', () => layoutDashBars());
  layoutDashBars();
}
