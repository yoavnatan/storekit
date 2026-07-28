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

/** Failure notice — same surface, held a beat longer than an info toast. */
export function showErrorToast(title: string, body = ''): void {
  showToast(title, body, 6000);
}
