// Seller dashboard → "תשלומים" tab → the bank + business details form
// (components/dashboard/PayoutsPanel.astro).
//
// One save, over `fetch`, with the page updated in place — no reload (memory `feedback_ajax_forms`).
// Everything else on the panel is server-rendered and static, so this module is the whole of its
// interactivity.
//
// **The server is the only validator.** The fields carry `maxlength` and `inputmode` because those
// help someone typing, and nothing here decides whether a submission is acceptable: the same
// `parsePayoutDetails` the route runs would have to be duplicated to do it, and a client copy of a
// money rule is a copy that drifts. A refusal comes back with the FIELD that caused it, which is
// what lets this focus the right box instead of printing one message above six.

import { showToast, showErrorToast } from '../../lib/toast.js';
import { busyButton } from './btn-busy.js';

interface SaveResponse { ok?: boolean; error?: string; field?: string; bankLine?: string | null }

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initPayoutsTab(): void {
  const form = document.getElementById('pay-details-form') as HTMLFormElement | null;
  const save = document.getElementById('pay-details-save') as HTMLButtonElement | null;
  const error = document.getElementById('pay-details-error');
  if (!form || !save || !error) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = i18n();
    error.classList.add('hidden');

    const data = new FormData(form);
    const busy = busyButton(save, t['payDetailsSave'] ?? 'Save');
    try {
      const res = await fetch('/api/seller/payout-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(data.entries())),
      });
      const body = await res.json() as SaveResponse;

      if (!res.ok || !body.ok) {
        // Beside the form, not as a toast: the seller is looking at the fields, and the message
        // names one of them.
        error.textContent = body.error ?? (t['payDetailsFailed'] ?? 'Could not save.');
        error.classList.remove('hidden');
        if (body.field) form.querySelector<HTMLElement>(`[name="${body.field}"]`)?.focus();
        return;
      }

      showToast(t['payDetailsSaved'] ?? 'Saved');
      // What was just written is the state a later "discard" comes back to, and it is what stops
      // the floating unsaved-changes bar from claiming this form still holds work (unsaved-guard.ts
      // listens for exactly this event).
      window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form } }));
      // The banner exists to say "there is money here and nowhere to send it". The moment there is
      // somewhere, it is answered — leaving it up until the next page load would keep telling the
      // seller to do a thing they have just done.
      if (body.bankLine) document.getElementById('pay-no-bank-banner')?.remove();
    } catch {
      // A network failure, as a toast: nothing on screen is wrong, the request simply did not land.
      showErrorToast(t['payDetailsFailed'] ?? 'Could not save.');
    } finally {
      busy.done();
    }
  });
}
