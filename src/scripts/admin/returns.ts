import { showToast, showActionFailedToast } from '../../lib/toast.js';
import { showFieldError, clearFieldError } from '../../lib/field-validity.js';
import { toAgorot, formatAgorot } from '../../lib/money.js';

/**
 * The admin's two buttons on a disputed return — the only decision in this mechanism a clock cannot
 * make.
 *
 * Everything else about returns runs itself (`returns-run.ts`). What is left here is one question a
 * machine has no way to answer: the seller says the parcel came back empty, the buyer says it did
 * not, and somebody has to choose. So there are exactly two buttons, and they say what happens
 * rather than what they set — "זכה את הקונה", not "set status refunded".
 *
 * A confirm step, because both outcomes move real money and neither is reversible by another button
 * on this screen: refunding credits a buyer out of the seller's balance, and rejecting closes the
 * request for good. `ConfirmModal` is the site's own dialog — the native `confirm()` is banned
 * platform-wide.
 */
export function initAdminReturnsPanel(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-admin-return]').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';

    btn.addEventListener('click', () => {
      const id = btn.dataset.adminReturn ?? '';
      const to = btn.dataset.adminTo ?? '';
      const forBuyer = to === 'refunded';

      const noteEl = document.querySelector<HTMLTextAreaElement>(`[data-admin-note-for="${id}"]`);
      const awardEl = document.querySelector<HTMLInputElement>(`[data-admin-award-for="${id}"]`);
      // Both cleared before either is judged: a second press must not leave the previous press's
      // red line under a field the admin has since fixed.
      if (noteEl) clearFieldError(noteEl);
      if (awardEl) clearFieldError(awardEl);

      // The reason is required and the server enforces it; this is the half that says so BEFORE the
      // dialog, because being refused after confirming an irreversible action is the worst order to
      // learn it in.
      //
      // **On the FIELD, never in a toast (owner, 2026-08-20).** A toast is for something that
      // happened somewhere else; a field that is wrong says so where it is wrong, in the site's one
      // style — the red rule and a line underneath (`lib/field-validity.ts`, which every other form
      // here already uses). This screen predates that helper and kept its own toast, so the platform
      // had two answers to one question on the single screen that decides a dispute.
      const note = noteEl?.value.trim() ?? '';
      if (note.length < 3) {
        if (noteEl) showFieldError(noteEl, 'צריך לכתוב למה החלטת — זה נשמר בתיק.');
        noteEl?.focus();
        return;
      }

      // Empty = the whole refund, which is what the placeholder says. Shekels here because that is
      // what a person types; it converts to agorot at this boundary and nowhere else.
      const typed = awardEl?.value.trim() ?? '';
      const fullAgorot = Number(btn.dataset.adminFull ?? '0');
      const awardAgorot = typed === '' ? null : toAgorot(Number(typed));
      if (forBuyer && awardAgorot !== null && (!Number.isFinite(awardAgorot) || awardAgorot < 0)) {
        if (awardEl) showFieldError(awardEl, 'מספר, או ריק כדי להחזיר הכל.');
        awardEl?.focus();
        return;
      }
      const partial = forBuyer && awardAgorot !== null && awardAgorot < fullAgorot;
      // The site's own formatter, so the dialog's figure reads exactly like the one on the card.
      const asShekels = formatAgorot;

      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          // The dialog states the amount it is actually about. A fixed "all the money?" over a
          // decision that awards part of it is the dialog lying about what the button does.
          title: !forBuyer ? 'לסגור את הבקשה בלי להחזיר כסף?'
            : partial ? `להחזיר לקונה ${asShekels(awardAgorot!)}?`
            : 'להחזיר לקונה את כל הכסף?',
          // `message`, not `body` — `ConfirmModal` reads `detail.message` and nothing else, so this
          // dialog had been showing the generic "אי אפשר לבטל את זה" default instead of the sentence
          // that names the amount. On the platform's single most money-critical confirmation: the
          // admin deciding a dispute, where the whole point of the dialog is to state WHAT it is
          // about before he presses it. Every other caller on the platform already said `message`;
          // this one was written alone and nothing connected the two (owner asked whether the
          // critical actions have a dialog at all, 2026-08-20).
          message: !forBuyer
            ? 'הקונה לא יקבל כסף בחזרה והבקשה תיסגר. אי אפשר לבטל את זה כאן.'
            : partial
              ? `${asShekels(awardAgorot!)} מתוך ${asShekels(fullAgorot)} יירשמו כחוב לקונה, וירדו למוכר מהתשלום הבא שלו. ההזמנה נשארת כפי שהיא. אי אפשר לבטל את זה כאן.`
              : 'הכסף יירשם כחוב לקונה, וירד למוכר מהתשלום הבא שלו. אי אפשר לבטל את זה כאן.',
          okLabel: forBuyer ? 'החזר לקונה' : 'סגור בלי החזר',
          // Red is for the branch that closes the case against somebody — here, ending it with the
          // buyer getting nothing. Awarding him the refund is the ordinary outcome of a return and
          // wears the primary skin, same rule as the seller's own approve dialog (owner,
          // 2026-08-20/21). Guarded by `confirm-modal-contract`.
          tone: forBuyer ? ('primary' as const) : ('danger' as const),
          onConfirm: async () => {
            try {
              const res = await fetch('/api/returns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id, to, adminNote: note,
                  ...(partial ? { adminAwardAgorot: awardAgorot } : {}),
                }),
              });
              if (!res.ok) {
                const said = await res.json().catch(() => null) as { error?: string } | null;
                if (said?.error) showToast('לא בוצע', said.error);
                else showActionFailedToast();
                return;
              }
              // A reload rather than a patch: this move changes the order, the seller's held
              // balance and the money journal, and a screen showing one of the four is a screen
              // disagreeing with the other three.
              location.reload();
            } catch {
              showActionFailedToast();
            }
          },
        },
      }));
    });
  });
}
