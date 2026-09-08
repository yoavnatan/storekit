// Seller dashboard → הגדרות → "החשבון שלי" (components/dashboard/SellerAccountCard.astro).
//
// One save over `fetch`, no reload (memory `feedback_ajax_forms`). Its own form and its own route
// precisely because the panel's big form posts to `/api/store`: the account is not the shop, and a
// "save changes" bar governing fields it does not save is the confusion the panel's head comment
// already argues against for the categories tree.
//
// The server is the only validator. `updateSeller` owns what an email may be and what a duplicate
// means, and a second copy of those rules here is a copy that drifts.
import { showErrorToast } from '../../lib/toast.js';
import { busyButton } from './btn-busy.js';

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initSellerAccountCard(): void {
  const form = document.getElementById('seller-account-form') as HTMLFormElement | null;
  const save = document.getElementById('seller-account-save') as HTMLButtonElement | null;
  const error = document.getElementById('seller-account-error');
  if (!form || !save) return;
  const t = i18n();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const busy = busyButton(save, t.accountSave ?? 'Save');
    error?.classList.add('hidden');
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const res = await fetch('/api/user/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) {
        // Beside the form, never a toast: the seller is looking straight at the fields, and the
        // message names one of them.
        if (error) { error.textContent = body.error ?? (t.accountFailed ?? ''); error.classList.remove('hidden'); }
        return;
      }
      // In the button he pressed, not in a corner of the screen — the same ruling `payouts.ts`
      // carries for its own save.
      busy.confirm(t.accountSaved ?? 'Saved');
      // What was written IS the state a later "discard" comes back to, and it is what stops the
      // floating unsaved-changes bar from claiming this form still holds work.
      window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form } }));
    } catch {
      showErrorToast(t.accountFailed ?? '');
    } finally {
      busy.done();
    }
  });
}
