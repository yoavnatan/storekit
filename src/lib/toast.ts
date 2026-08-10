/**
 * Client-side toast helper.
 *
 * The site has exactly one toast surface (`ToastContainer.astro`, rendered by
 * `BaseLayout`), driven by a `toast:show` event. This wraps that event so no
 * caller hand-builds the CustomEvent — and so no failure path is ever tempted
 * back into a native `alert()`, which is banned site-wide: every message the
 * user sees must be the site's own UI (confirmations go through
 * `ConfirmModal.astro`'s `confirm:open` event, notices come through here).
 *
 * No dedup `key` on errors on purpose: a retry that fails again must speak up.
 */
export function showToast(title: string, body = '', duration?: number): void {
  window.dispatchEvent(new CustomEvent('toast:show', { detail: { title, body, duration } }));
}

/**
 * Failure notice — same surface, but it has to be TELLABLE from a success one.
 *
 * Until 2026-08-10 it differed only in living 6s instead of 5s, which is not a difference
 * anybody can see: "נשמר" and "לא נשמר" arrived as the same card in the same blue, and the
 * only thing separating them was the sentence itself. That also failed the accessibility
 * rule this project holds to — state is never carried by one channel alone — because both
 * were announced as `role="status"`, i.e. politely, i.e. after whatever the screen reader
 * was already saying.
 *
 * `tone: 'error'` changes two things and nothing else: the accent bar the card ALREADY has
 * turns `--color-danger` (a hue swap on an existing part, not a second design), and the card
 * is announced as `role="alert"`. Restraint is deliberate — a red-filled toast for "couldn't
 * save a draft" is the kind of shouting that gets toasts ignored altogether.
 */
export function showErrorToast(title: string, body = ''): void {
  window.dispatchEvent(
    new CustomEvent('toast:show', { detail: { title, body, duration: 6000, tone: 'error' } }),
  );
}
