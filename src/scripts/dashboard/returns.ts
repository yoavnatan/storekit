import { showToast, showActionFailedToast } from '../../lib/toast.js';

/**
 * The returns tab's buttons — the seller's four verbs, wired to the one route.
 *
 * ── Every failure is spoken ──
 * A dropped request must not leave the button re-enabled and the screen looking idle, which is the
 * whole class `tests/silent-failure-guard.test.ts` exists to refuse (audit row 11). So: one `catch`
 * for the network, an explicit read of `res.ok`, and the server's own message when it sent one —
 * the API answers 409 with a sentence a person can act on ("בקשה כזאת כבר פתוחה"), and swallowing
 * that in favour of a generic toast would throw away the only useful part.
 *
 * ── Why the page reloads instead of patching the card ──
 * A move changes more than the card: the tab badge, the payments tab's held total, and — on a
 * refund — the order's own status. Patching one card would leave three surfaces stale and disagreeing
 * with each other, which is precisely the "money and what a seller SEES disagree" class this project
 * audited. A reload is a few hundred milliseconds on a tab that is opened rarely, and it cannot be
 * wrong.
 */
export function initReturnsTab(): void {
  const list = document.querySelector<HTMLElement>('[data-returns-list]');
  if (!list || list.dataset.wired) return;
  list.dataset.wired = '1';

  list.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-return-move]');
    if (!btn) return;
    const to = btn.dataset.returnMove;
    const id = btn.dataset.returnTarget;
    if (!to || !id) return;

    // Disable the whole card's buttons, not just the one pressed: "approve" and "reject" sit beside
    // each other, and a second click while the first is in flight is a race whose loser gets a 409
    // that reads like a bug.
    const card = btn.closest<HTMLElement>('[data-return-id]');
    const buttons = card ? [...card.querySelectorAll<HTMLButtonElement>('button')] : [btn];
    buttons.forEach((b) => { b.disabled = true; });

    // An offer needs a number, and it is the only move on this screen that does. Asked with a
    // prompt-free inline field rather than `prompt()`, which is banned platform-wide — the field is
    // already on the card, hidden until this button is pressed.
    let partialOfferAgorot: number | undefined;
    if (to === 'offered') {
      const field = card?.querySelector<HTMLInputElement>('[data-offer-amount]');
      if (field && field.hidden) {
        field.hidden = false;
        field.focus();
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      const shekels = Number(field?.value ?? '');
      if (!Number.isFinite(shekels) || shekels <= 0) {
        showToast('לא בוצע', 'צריך לכתוב סכום גדול מאפס');
        buttons.forEach((b) => { b.disabled = false; });
        return;
      }
      // Agorot at the boundary, like every other amount that crosses into the server (money.ts).
      partialOfferAgorot = Math.round(shekels * 100);
    }

    void (async () => {
      try {
        const res = await fetch('/api/returns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, to, ...(partialOfferAgorot ? { partialOfferAgorot } : {}) }),
        });
        if (!res.ok) {
          const said = await res.json().catch(() => null) as { error?: string } | null;
          // The server's sentence when it has one — it knows why, and this does not.
          if (said?.error) showToast('לא בוצע', said.error);
          else showActionFailedToast();
          buttons.forEach((b) => { b.disabled = false; });
          return;
        }
        location.reload();
      } catch {
        showActionFailedToast();
        buttons.forEach((b) => { b.disabled = false; });
      }
    })();
  });
}
