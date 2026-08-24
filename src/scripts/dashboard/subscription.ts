// Seller dashboard → "תשלומים" tab → the go-live screen's last step
// (components/dashboard/SubscriptionCard.astro + GoLiveSteps.astro).
//
// Three controls and no form, so there is nothing here to validate and nothing to keep in sync: the
// server decides everything and this file moves the browser to where the server says to go.
//
// **Starting is a REDIRECT, not a state change on this page.** PayMe's own payment page is where the
// card is typed (`lib/seller-subscription.ts` says why it cannot be typed here), so a success is a
// navigation and there is deliberately no optimistic re-render — the page a seller comes back to is
// re-read from the server, which is the only thing that knows whether the charge went through.
//
// **Every call names a STORE.** Since 2026-08-24 the plan and the monthly line belong to the shop,
// not to the account (`lib/store-plan.ts`), so "start paying" means "put THIS shop on the site" and
// the id travels with it. The server never trusts it as a permission — it prices only shops the
// session's own seller owns — but without it the server cannot know which shop is being published,
// because being published is exactly what is being paid for.
import { showToast, showErrorToast } from '../../lib/toast.js';
import { busyButton } from './btn-busy.js';

interface StartResponse { ok?: boolean; error?: string; payUrl?: string; published?: string[] }

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

async function post(body: Record<string, unknown>): Promise<StartResponse> {
  const res = await fetch('/api/seller/subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

  // ── Which plan this shop is on ────────────────────────────────────────────────────────────
  // Four pills. The write goes through `/api/seller/tier`, which patches the standing order at
  // PayMe FIRST and records the plan only if they accepted — so a refusal here leaves the shop on
  // the plan the card is actually paying for, and the button simply springs back.
  const plans = document.getElementById('go-live-plans');
  const storeId = plans?.dataset['store'] ?? document.getElementById('sub-start')?.dataset['store'] ?? '';
  plans?.querySelectorAll<HTMLButtonElement>('[data-role="plan"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('btn--accent')) return;  // already on it: a no-op click moves nothing
      const busy = busyButton(btn, btn.textContent?.trim() ?? '');
      try {
        const res = await fetch('/api/seller/tier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier: btn.dataset['tier'], storeId }),
        });
        if (!res.ok) {
          // 502 is the gateway refusing to move a standing order; anything else is ours. Both mean
          // the same thing to the seller — the plan did not change — so both say it.
          showErrorToast(res.status === 502 ? (t['subGatewayFailed'] ?? '') : (t['subFailed'] ?? ''));
          return;
        }
        const body = await res.json().catch(() => ({})) as { fromNextCharge?: boolean };
        // Re-read rather than repainted: the plan changes the commission line, the monthly total
        // and the breakdown beside it, and patching three numbers by hand is how one of them starts
        // disagreeing with the server.
        showToast(body.fromNextCharge ? (t['subPlanFromNextCharge'] ?? '') : (t['subPlanSaved'] ?? ''));
        window.location.reload();
      } catch {
        showErrorToast(t['subFailed'] ?? '');
      } finally {
        busy.done();
      }
    });
  });

  // ── Putting the shop on the site ──────────────────────────────────────────────────────────
  const start = document.getElementById('sub-start') as HTMLButtonElement | null;
  start?.addEventListener('click', async () => {
    error?.classList.add('hidden');
    const busy = busyButton(start, start.textContent?.trim() || (t['subStart'] ?? 'Start'));
    try {
      const data = await post({ storeId: start.dataset['store'] ?? '' });
      if (!data.ok) {
        // The one error worth its own sentence: he has no shop ready to go on the site, so there is
        // nothing to charge for. Anything else is the generic failure.
        fail(data.error === 'no-store-to-bill' ? t['subNoStore'] : undefined);
        return;
      }
      // The ordinary outcome: PayMe want the seller on their page. The button stays busy through the
      // navigation on purpose — restoring it would flash an idle button as the page unloads.
      if (data.payUrl) { window.location.href = data.payUrl; return; }
      // No URL means the charge already went through server-to-server, which today only happens on
      // the token route — or the standing order was simply patched to include this shop. Either way
      // the shop may have gone live in that same request, so the page is re-read rather than patched.
      window.location.reload();
    } catch {
      fail();
    } finally {
      // Only reached when nothing navigated.
      busy.done();
    }
  });

  // ── Stopping ──────────────────────────────────────────────────────────────────────────────
  // Two presses, and the thing between them is not an "are you sure": it is the two alternatives
  // that are actually cheaper than leaving, beside a cancel button of the same size. The panel is
  // in the page rather than a modal because it contains a LINK he may want to follow and read.
  const cancel = document.getElementById('sub-cancel') as HTMLButtonElement | null;
  const panel = document.getElementById('sub-cancel-panel');
  cancel?.addEventListener('click', () => {
    panel?.classList.toggle('!hidden');
    // Moves something on every press, in both directions — a control whose second press does
    // nothing visible is the no-op the site bans.
    cancel.setAttribute('aria-expanded', String(!panel?.classList.contains('!hidden')));
  });

  const confirm = document.getElementById('sub-cancel-confirm') as HTMLButtonElement | null;
  confirm?.addEventListener('click', async () => {
    const busy = busyButton(confirm, confirm.textContent?.trim() ?? '');
    try {
      const data = await post({ action: 'cancel' });
      if (!data.ok) { fail(); return; }
      // The toast says the one thing he needs: nothing more will be charged, and he keeps what he
      // paid for until the date. The page then re-reads and the card shows that date standing.
      showToast(t['subCanceled'] ?? '');
      window.location.reload();
    } catch {
      fail();
    } finally {
      busy.done();
    }
  });
}
