/** Drag a bottom sheet down to dismiss it (touch only).
 *
 *  On mobile the cart drawer slides up from the bottom edge, and a bottom sheet that can only be
 *  closed by a 32px × button in its far corner is the one gesture every phone user tries first
 *  and this one didn't answer. This adds it: the sheet follows the finger, and a flick or a long
 *  enough pull closes it.
 *
 *  Touch only, deliberately. On a mouse the drawer is a side panel, not a sheet, and a
 *  drag-to-close there competes with text selection for no benefit — the × and Escape are the
 *  desktop gestures. `enabled()` is asked at the START of every gesture rather than once at
 *  setup, so a rotation or a resize across the breakpoint is already handled.
 *
 *  Two places a drag may begin, and the distinction is what keeps it from fighting the content:
 *    - the grab handle / header — always draggable, that is what a handle is for;
 *    - the scrollable body — only when it is already scrolled to the top AND the finger is moving
 *      DOWN, which is exactly the moment scrolling has nothing left to do. Anywhere else the
 *      gesture belongs to the list.
 *
 *  The decision is made on the FIRST move of a gesture and then held: reversing direction
 *  mid-drag keeps dragging the sheet rather than handing the gesture back to the scroller, which
 *  is what makes the sheet feel attached to the finger instead of slipping out of it.
 */

export interface SheetDragOptions {
  /** The sheet element. Its inline `transform`/`transition` are driven here and always cleared. */
  sheet: HTMLElement;
  /** Scrollable content inside the sheet, if any — a drag starts from it only at scrollTop 0. */
  content?: HTMLElement | null;
  /** Anything inside these always starts a drag, wherever it has scrolled to. */
  handles?: (HTMLElement | null | undefined)[];
  /** Is the sheet currently a bottom sheet AND open? Asked at the start of every gesture. */
  enabled: () => boolean;
  /** Dismiss. The sheet is already parked at translateY(100%) when this runs, so the caller's own
   *  close transition continues from where the finger left it instead of jumping. */
  onDismiss: () => void;
  /** Follows the drag, 1 → 0, for a backdrop that fades out with the sheet. Called with `null`
   *  on release, meaning "hand this property back to CSS" — an inline opacity left behind would
   *  outrank the backdrop's own open/closed rules and it would never show again. */
  onProgress?: (visible: number | null) => void;
}

/** Past this share of the sheet's height, letting go closes it. */
const DISMISS_RATIO = 0.28;
/** …or a flick faster than this (px per ms) closes it whatever the distance. */
const FLICK_VELOCITY = 0.45;
/** Movement below this is a tap or a jitter, not yet a direction. */
const DIRECTION_SLOP = 6;
/** Matches the sheet's own CSS transition, so the inline override is cleared only once the
 *  animation it was driving has finished. */
const SETTLE_MS = 300;

export function attachSheetDrag(opts: SheetDragOptions): void {
  const { sheet, content, handles = [], enabled, onDismiss, onProgress } = opts;

  let startY = 0;
  let offset = 0;
  // Velocity is measured over the LAST stretch of the gesture, not the whole of it: a shopper who
  // reads the cart, then flicks it away, has a gesture that is mostly stationary — averaging over
  // its full duration would report almost no speed and the flick would not register.
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0;
  let dragging = false;
  /** null = the first move hasn't decided yet; false = this gesture belongs to the content. */
  let claimed: boolean | null = null;

  const fromHandle = (target: EventTarget | null): boolean =>
    target instanceof Node && handles.some((h) => h?.contains(target));

  function paint(y: number): void {
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${y}px)`;
    if (onProgress) onProgress(1 - Math.min(1, y / Math.max(1, sheet.offsetHeight)));
  }

  /** Hand the sheet back to CSS. `transform` is set to the closing position first when
   *  dismissing, so the transition runs from the finger's last position rather than snapping to
   *  the top and sliding from there. */
  function release(dismiss: boolean): void {
    sheet.style.transition = '';
    sheet.style.transform = dismiss ? 'translateY(100%)' : '';
    // Cleared BEFORE the dismiss, so the backdrop's own transition picks up from wherever the
    // drag left it and fades the rest of the way instead of blinking out.
    if (onProgress) onProgress(null);
    if (dismiss) onDismiss();
    window.setTimeout(() => { sheet.style.transform = ''; }, SETTLE_MS);
  }

  sheet.addEventListener('touchstart', (e: TouchEvent) => {
    if (e.touches.length !== 1 || !enabled()) { claimed = false; return; }
    startY = lastY = e.touches[0]!.clientY;
    lastAt = e.timeStamp;
    velocity = 0;
    offset = 0;
    dragging = false;
    claimed = null;
  }, { passive: true });

  // Non-passive: once this gesture is the sheet's, the browser must not also scroll or
  // rubber-band the page underneath it.
  sheet.addEventListener('touchmove', (e: TouchEvent) => {
    if (claimed === false || e.touches.length !== 1) return;
    const dy = e.touches[0]!.clientY - startY;

    if (claimed === null) {
      if (Math.abs(dy) < DIRECTION_SLOP) return;
      // A handle drag is the sheet's in either direction (upward simply resists at 0). From the
      // content it is the sheet's only when the list has nothing left to scroll away.
      const atTop = !content || content.scrollTop <= 0;
      claimed = fromHandle(e.target) || (atTop && dy > 0);
      if (!claimed) return;
      dragging = true;
    }

    e.preventDefault();
    const y = e.touches[0]!.clientY;
    const dt = e.timeStamp - lastAt;
    if (dt > 0) velocity = (y - lastY) / dt;
    lastY = y;
    lastAt = e.timeStamp;
    // Pulling up past the open position does nothing — a sheet has no "more open".
    offset = Math.max(0, dy);
    paint(offset);
  }, { passive: false });

  /** Either threshold closes it: pulled far enough, or thrown fast enough. Distance alone would
   *  ignore a quick flick from near the top, which on a phone is the commonest dismissal of all. */
  sheet.addEventListener('touchend', () => {
    if (!dragging) { claimed = false; return; }
    dragging = false;
    claimed = false;
    release(offset > sheet.offsetHeight * DISMISS_RATIO || velocity > FLICK_VELOCITY);
  });

  // A cancelled touch (an incoming call, the system gesture area) must not leave the sheet
  // stranded half-way down with its transition switched off.
  sheet.addEventListener('touchcancel', () => {
    if (!dragging) { claimed = false; return; }
    dragging = false;
    claimed = false;
    release(false);
  });
}
