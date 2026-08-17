import { scrollBelowPinnedChrome } from './scroll-utils.js';

let statusTimer: ReturnType<typeof setTimeout>;

/**
 * Where the confirmation banner goes.
 *
 * **This used to be `document.querySelector('.products-header')?.after(el)`, and that class had
 * stopped existing.** Nothing in `src/` renders it any more — the dashboard's panel headers are
 * `.dash-panel-head` — so `?.` swallowed the miss, the banner was created and never inserted, and
 * `scrollBelowPinnedChrome` was then handed a node with no parent. The symptom, reported by the
 * owner on the advertising tab (2026-08-17): pause or resume a campaign and the page twitches a
 * few pixels while nothing else happens at all. It was never about campaigns — **all 56 call
 * sites across five dashboard modules had been silently invisible**, which is every "saved",
 * "updated" and "deleted" confirmation the seller was supposed to get. This is the
 * no-op-interaction class exactly: the work succeeded every time, and the screen said nothing.
 *
 * So the anchor is now resolved by what is ON SCREEN rather than by a class name that a redesign
 * can quietly retire:
 *   1. the header of the panel the seller is actually looking at,
 *   2. that panel itself, if it has no header,
 *   3. the dashboard shell.
 * `offsetParent` is the test for "visible", because the dashboard keeps every panel in the
 * document and only shows one — asking the DOM which one is rendered needs no knowledge of the
 * mechanism that hides the others, and survives the next change to it.
 *
 * And the banner is only scrolled to once it is really in the document, so the worst case is a
 * message the seller has to look for — never a page that jumps toward nothing.
 */
function insertStatus(el: HTMLElement, anchor?: Element | null): boolean {
  const visible = (node: Element | null): boolean => !!node && !!(node as HTMLElement).offsetParent;

  // The thing the seller just acted on, when the caller knows it. A panel-top banner is the right
  // answer for a form that fills the screen and the wrong one for a row halfway down a list — the
  // owner's report (2026-08-17) was that pausing a campaign put the confirmation somewhere he
  // never saw. Above the anchor rather than below it, so the message does not push the card the
  // eye is already on.
  if (anchor?.isConnected) { anchor.before(el); return true; }

  const heads = [...document.querySelectorAll<HTMLElement>('[id^="dash-panel-"] .dash-panel-head')];
  const head = heads.find(visible);
  if (head) { head.after(el); return true; }

  const panel = [...document.querySelectorAll<HTMLElement>('[id^="dash-panel-"]')].find(visible);
  if (panel) { panel.prepend(el); return true; }

  // `<main>`, deliberately, and not a dashboard class: BaseLayout renders it on every page, so it
  // is the one anchor that cannot be retired by a redesign — which is the entire bug above.
  const shell = document.querySelector('main');
  if (shell) { shell.prepend(el); return true; }

  // **The last resort always succeeds, and that is the point of it.** An earlier version of this
  // function returned false here and `showStatus` gave up — which quietly recreated the bug it was
  // written to fix, in the one case where the page is not shaped the way it was expected to be.
  // `document.body` is the floor: a banner at the top of the document is a message the seller may
  // have to look for, and that is strictly better than no message at all. There is no branch below
  // this one, so a caller can rely on the banner existing.
  document.body.prepend(el);
  return true;
}

/**
 * @param anchor The element the seller just acted on. Given one, the banner appears directly ABOVE
 *   it instead of at the top of the panel — the difference between a confirmation and a
 *   confirmation he can see. A caller that re-renders its list must pass the NEW element and call
 *   this AFTER the re-render: an anchor captured beforehand is already detached
 *   (`project_href_frozen_at_render` is the same trap in another costume), and a detached one is
 *   ignored here rather than trusted, so the worst case is the old panel-top placement.
 */
export function showStatus(msg: string, isError = false, anchor?: Element | null): void {
  let el = document.getElementById('ajax-status');
  if (!el) {
    el = document.createElement('p');
    el.id = 'ajax-status';
  }
  el.className = isError
    ? 'dash-error bg-[#fef2f2] text-[color:var(--color-danger)] py-2 px-[.85rem] rounded-[var(--radius)] border border-[#fecaca] text-sm mb-4'
    : 'dash-success bg-[#f0fdf4] text-[#166534] py-2 px-[.85rem] rounded-[var(--radius)] border border-[#bbf7d0] text-sm mb-4';
  el.textContent = msg;
  // Announced, not merely drawn: the banner appears somewhere the seller may not be looking, and
  // for an error especially, a screen reader has to hear it without moving focus.
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.setAttribute('aria-live', isError ? 'assertive' : 'polite');

  // Re-anchored on every call, not only when created. A panel swap can leave the banner attached
  // to a panel that is no longer on screen, which is the same invisibility in a slower form.
  // Re-anchored whenever it is orphaned OR whenever this call names a different target — a banner
  // left above the previous campaign card is the same invisibility, just one row up.
  if (!el.isConnected || !(el.parentElement as HTMLElement | null)?.offsetParent
      || (anchor?.isConnected && el.nextElementSibling !== anchor)) {
    insertStatus(el, anchor);
  }

  // **Bring the message to the seller, do not hope it is already there (reported 2026-08-03).**
  // Two things were wrong with `scrollIntoView({block:'nearest'})` here. `nearest` does nothing
  // when the element is technically "in view" — including when it is sitting UNDER the products
  // table's sticky header, which is exactly where it lands — so after adding a product the form
  // collapsed and the confirmation was never seen; the seller had to scroll up to find out whether
  // it had worked at all. And native `behavior:'smooth'` is banned on this RTL site: it drifts
  // `scrollX` off 0 mid-animation and cannot be corrected (see scroll-utils.ts / animateScrollTo).
  // `scrollBelowPinnedChrome` exists for precisely this — it parks the target clear of every
  // pinned layer above it.
  scrollBelowPinnedChrome(el);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el?.remove(), 3000);
}
