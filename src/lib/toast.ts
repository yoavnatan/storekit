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

/**
 * "That didn't go through" — the default answer whenever something the user PRESSED failed and
 * there is no more specific thing to say.
 *
 * **Why it is a function and not twelve string literals.** An audit on 2026-08-10 walked every
 * `fetch` in the app and found the same hole in eleven places: a reply that never sent, an order
 * status that never saved, a note that vanished on save, a filter that changed nothing — each one
 * a `catch { /* ignore *&#47; }` or an `if (!res.ok) return`, each one re-enabling its button so the
 * screen looked idle and correct. Six other places already handled it, and every one of them had
 * hand-written its own Hebrew sentence, which is how the same failure came to have six wordings.
 *
 * The copy is deliberately about the ACTION and not the cause: a user cannot act on "500", and
 * "check your connection" is wrong as often as it is right. It says the thing did not happen and
 * that pressing again is reasonable — which is true of every retryable action, and this is only
 * ever used where retrying is safe. **A money-moving action does NOT belong here**: a charge that
 * may or may not have landed must say so specifically, never invite a blind retry.
 */
export function showActionFailedToast(): void {
  const s = (() => {
    try {
      const json = document.getElementById('i18n-data')?.textContent ?? '{}';
      return (JSON.parse(json) as { common?: { actionFailedTitle?: string; actionFailedBody?: string } }).common ?? {};
    } catch {
      return {};
    }
  })();
  showErrorToast(s.actionFailedTitle ?? 'הפעולה לא בוצעה', s.actionFailedBody ?? 'משהו השתבש בדרך לשרת. נסו שוב.');
}
