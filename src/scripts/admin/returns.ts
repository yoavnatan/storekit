import { showToast, showActionFailedToast } from '../../lib/toast.js';
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

      // The reason is required and the server enforces it; this is the half that says so BEFORE the
      // dialog, because being refused after confirming an irreversible action is the worst order to
      // learn it in. Focused rather than only announced — the field is what he has to go back to.
      const noteEl = document.querySelector<HTMLTextAreaElement>(`[data-admin-note-for="${id}"]`);
      const note = noteEl?.value.trim() ?? '';
      if (note.length < 3) {
        showToast('חסר הסבר', 'צריך לכתוב למה החלטת. זה נשמר בתיק ומסביר את ההחלטה אם מישהו יחזור אליה.');
        noteEl?.focus();
        return;
      }

      // Empty = the whole refund, which is what the placeholder says. Shekels here because that is
      // what a person types; it converts to agorot at this boundary and nowhere else.
      const awardEl = document.querySelector<HTMLInputElement>(`[data-admin-award-for="${id}"]`);
      const typed = awardEl?.value.trim() ?? '';
      const fullAgorot = Number(btn.dataset.adminFull ?? '0');
      const awardAgorot = typed === '' ? null : toAgorot(Number(typed));
      if (forBuyer && awardAgorot !== null && (!Number.isFinite(awardAgorot) || awardAgorot < 0)) {
        showToast('סכום לא תקין', 'אפשר להשאיר ריק כדי להחזיר הכל, או לכתוב מספר.');
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
          body: !forBuyer
            ? 'הקונה לא יקבל כסף בחזרה והבקשה תיסגר. אי אפשר לבטל את זה כאן.'
            : partial
              ? `${asShekels(awardAgorot!)} מתוך ${asShekels(fullAgorot)} יירשמו כחוב לקונה, וירדו למוכר מהתשלום הבא שלו. ההזמנה נשארת כפי שהיא. אי אפשר לבטל את זה כאן.`
              : 'הכסף יירשם כחוב לקונה, וירד למוכר מהתשלום הבא שלו. אי אפשר לבטל את זה כאן.',
          okLabel: forBuyer ? 'החזר לקונה' : 'סגור בלי החזר',
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
