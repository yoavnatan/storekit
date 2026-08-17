/**
 * The ✓ hold: a button that says the thing it just did, on itself.
 *
 * **Why a shared module rather than a fourth copy.** This treatment was written by hand in
 * `ui.ts` (store settings save) and again in `promotions.ts` (sale save), and the owner asked for
 * it a third time on the advertising tab (2026-08-17) — *"למה לא פשוט להוסיף וי על הכפתור
 * לרגע?"*. Three hand-rolled copies of one rule is the shape this repo's review checklist calls
 * "the next bug", and `btn-busy.ts` is the precedent: the in-flight half of the same button was
 * extracted for exactly this reason.
 *
 * **Why it beats a notice.** A toast is right when there is nothing on screen to speak from. When
 * the seller has just pressed a button and is looking at it, the button IS the place — nothing
 * moves, nothing has to be found, and the confirmation cannot land off screen. That is also why
 * `btn--confirmed` exists in `components/buttons.css`: it keeps full opacity and a default cursor
 * while the control stays disabled, so the hold reads as success and not as "this is broken".
 *
 * The hold blocks a double-submit for its whole duration, which is the second job it quietly does.
 */
const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>';

import { escapeHtml } from '../../lib/html-escape.js';

export interface ConfirmFlashOptions {
  /** What the button says during the hold. Falls back to a tick on its own. */
  label?: string;
  /** How long the ✓ stays. 1500ms is what the two hand-rolled copies settled on. */
  holdMs?: number;
}

/**
 * Show ✓ on `btn` for a moment, then put it back exactly as it was.
 *
 * Returns immediately; the restore happens on a timer. Safe to call on a button that is about to
 * be replaced by a re-render — the timer's callback checks `isConnected`, so a detached button is
 * left alone rather than being written to after its list has been redrawn.
 */
export function flashConfirmed(btn: HTMLButtonElement | null | undefined, options: ConfirmFlashOptions = {}): void {
  if (!btn) return;
  const { label = '', holdMs = 1500 } = options;
  const originalHtml = btn.innerHTML;
  const wasDisabled = btn.disabled;

  // **Both dimensions pinned, and the height is the one that was missed** (owner, 2026-08-17).
  // Width was obvious: a button that shrinks around a shorter word shuffles its neighbours. Height
  // is less obvious and looks worse — the ✓ replaces a line of TEXT, so without this the button
  // collapses to the icon's own 13px and the whole row of controls jumps as it goes and again as
  // it comes back. That is the reflow this treatment exists to avoid, happening inside the very
  // control that is supposed to be reassuring.
  //
  // Measured before anything is written, because reading `offsetHeight` after the swap would
  // measure the collapsed button.
  btn.style.minWidth = `${btn.offsetWidth}px`;
  btn.style.height = `${btn.offsetHeight}px`;
  btn.disabled = true;
  btn.classList.remove('btn--busy');
  btn.classList.add('btn--confirmed');
  btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">${CHECK_SVG}${label ? escapeHtml(label) : ''}</span>`;
  // The site's one spring (AI_INSTRUCTIONS, micro-interactions). Runs once — never `infinite`.
  // Optional because the Web Animations API is the one part of this that can be absent, and the
  // ✓ is the message while the pop is only its manners: a browser without `animate` must still
  // get the confirmation, not a thrown TypeError that swallows the rest of the handler.
  btn.animate?.(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
    { duration: 280, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  );

  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.disabled = wasDisabled;
    btn.classList.remove('btn--confirmed');
    btn.style.minWidth = '';
    btn.style.height = '';
    btn.innerHTML = originalHtml;
  }, holdMs);
}
