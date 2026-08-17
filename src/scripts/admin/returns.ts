import { showToast, showActionFailedToast } from '../../lib/toast.js';

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

      window.dispatchEvent(new CustomEvent('confirm:open', {
        detail: {
          title: forBuyer
            ? 'להחזיר לקונה את כל הכסף?'
            : 'לסגור את הבקשה בלי להחזיר כסף?',
          body: forBuyer
            ? 'הכסף יירשם כחוב לקונה, וירד למוכר מהתשלום הבא שלו. אי אפשר לבטל את זה כאן.'
            : 'הקונה לא יקבל כסף בחזרה והבקשה תיסגר. אי אפשר לבטל את זה כאן.',
          okLabel: forBuyer ? 'החזר לקונה' : 'סגור בלי החזר',
          onConfirm: async () => {
            try {
              const res = await fetch('/api/returns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, to }),
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
