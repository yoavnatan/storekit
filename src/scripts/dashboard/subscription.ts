// Seller dashboard → "תשלומים" tab → the monthly-subscription card
// (components/dashboard/SubscriptionCard.astro).
//
// Two buttons and no form, so there is nothing here to validate and nothing to keep in sync: the
// server decides everything and this file moves the browser to where the server says to go.
//
// **Starting is a REDIRECT, not a state change on this page.** PayMe's own payment page is where the
// card is typed (`lib/seller-subscription.ts` says why it cannot be typed here), so a success is a
// navigation and there is deliberately no optimistic re-render — the page a seller comes back to is
// re-read from the server, which is the only thing that knows whether the charge went through.
import { showToast, showErrorToast } from '../../lib/toast.js';
import { busyButton } from './btn-busy.js';

interface StartResponse { ok?: boolean; error?: string; payUrl?: string; published?: string[] }

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

async function post(action?: string): Promise<StartResponse> {
  const res = await fetch('/api/seller/subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action ? { action } : {}),
  });
  return await res.json() as StartResponse;
}

export function initSubscriptionCard(): void {
  const t = i18n();
  const error = document.getElementById('sub-error');
  const fail = (msg?: string): void => {
    if (!error) { showErrorToast(msg ?? t['subFailed'] ?? 'Failed'); return; }
    error.textContent = msg ?? t['subFailed'] ?? 'Failed';
    error.classList.remove('hidden');
  };

  const start = document.getElementById('sub-start') as HTMLButtonElement | null;
  start?.addEventListener('click', async () => {
    error?.classList.add('hidden');
    const busy = busyButton(start, start.textContent?.trim() || (t['subStart'] ?? 'Start'));
    try {
      const data = await post();
      if (!data.ok) { fail(); return; }
      // The ordinary outcome: PayMe want the seller on their page. The button stays busy through the
      // navigation on purpose — restoring it would flash an idle button as the page unloads.
      if (data.payUrl) { window.location.href = data.payUrl; return; }
      // No URL means the first charge already went through server-to-server, which today only
      // happens on the token route. The shop may have gone live in that same request, so the page is
      // re-read rather than patched.
      window.location.reload();
    } catch {
      fail();
    } finally {
      // Only reached when nothing navigated.
      busy.done();
    }
  });

  const cancel = document.getElementById('sub-cancel') as HTMLButtonElement | null;
  cancel?.addEventListener('click', () => {
    // Through the shared ConfirmModal, never `confirm()` — a standing site-wide ban (Hard rules).
    // Worth confirming at all because the seller is stopping the thing that keeps his shop on the
    // platform, and the body has to say the one thing he will worry about: the shop stays up.
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: t['subCancelConfirmTitle'] ?? 'Cancel?',
        message: t['subCancelConfirmBody'] ?? '',
        okLabel: t['subCancel'] ?? 'Cancel',
        onConfirm: async () => {
          const busy = busyButton(cancel, t['subCancel'] ?? 'Cancel');
          try {
            const data = await post('cancel');
            if (!data.ok) { fail(); return; }
            showToast(t['subCanceled'] ?? 'Cancelled');
            window.location.reload();
          } catch {
            fail();
          } finally {
            busy.done();
          }
        },
      },
    }));
  });
}
