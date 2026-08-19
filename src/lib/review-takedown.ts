import { showErrorToast } from './toast.js';

/**
 * Hiding a review, and putting it back — ONE implementation, for the two screens that offer it.
 *
 * The Reviews tab lists every review with this button, and a complaint about a review carries the
 * review inline with the same button, so that reading the complaint and acting on it are one screen
 * (owner, 2026-08-19). Written twice — which is the shape this repo keeps paying for — the two
 * would drift the first time only one of them was touched, and the drift would be invisible: both
 * buttons would still work, on different rules, on the moderation decision a seller lives with.
 *
 * Optimistic in the same shape as the product-block toggle in `stores.ts`: **the server's answer is
 * what the button ends up reflecting, never the click.** A failed request leaves the button saying
 * what is actually true and says so out loud — a silent catch here would tell an admin they had
 * taken a review down when they had not (`tests/silent-failure-guard.test.ts` holds that class).
 *
 * No `ConfirmModal`, unlike blocking a store: hiding a review is instantly reversible from the same
 * button, and a confirmation on a two-way switch is friction with nothing behind it.
 */

/** Wires the delegated handler onto a panel container. Delegated rather than bound per row so it
 *  survives `swapPanel` replacing the panel's innerHTML, and guarded by a dataset flag because the
 *  panel's init re-runs on every swap — a per-init binding stacks one listener per navigation and
 *  fires the request as many times as the admin has filtered. */
export function wireReviewTakedown(panelId: string): void {
  const panel = document.getElementById(panelId);
  if (!panel || panel.dataset.reviewTakedownWired) return;
  panel.dataset.reviewTakedownWired = '1';

  panel.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.admin-review-toggle');
    if (!btn) return;
    // A review inside a message thread sits on a row that opens the thread when clicked. Without
    // this, hiding a review also toggles the conversation open underneath it.
    event.stopPropagation();
    void toggleReview(btn);
  });
}

async function toggleReview(btn: HTMLButtonElement): Promise<void> {
  const wasBlocked = btn.dataset.blocked === '1';
  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/moderation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: wasBlocked ? 'show-review' : 'hide-review', reviewId: btn.dataset.reviewId }),
    });
    if (!res.ok) throw new Error('request failed');
    const { blocked } = await res.json() as { blocked: boolean };
    btn.dataset.blocked = blocked ? '1' : '';
    btn.textContent = blocked ? 'החזר לפרסום' : 'הסתר';
    btn.classList.toggle('btn--ghost', !blocked);
    // The BODY dims, not the row: fading the row fades this button with it, and the button that
    // undoes the action must never look like the action is unavailable (owner, 2026-08-19).
    const body = btn.closest<HTMLElement>('[data-review-row]')?.querySelector<HTMLElement>('[data-review-body]');
    if (body) body.style.opacity = blocked ? '0.55' : '1';
  } catch {
    showErrorToast('הפעולה נכשלה, נסו שוב');
  } finally {
    btn.disabled = false;
  }
}
