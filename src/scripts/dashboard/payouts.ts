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
import { scrollRowBackIntoView } from './scroll-utils.js';
import { registerPanelRefresh } from './tab-sync.js';

interface SaveResponse { ok?: boolean; error?: string; field?: string; bankLine?: string | null }

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

/**
 * Bring the panel up to date after an order moved — by re-reading the SERVER's own rendering of it.
 *
 * The bug (owner, 2026-08-10): every figure here is a snapshot taken when the dashboard loaded, and
 * changing an order's status on the Orders tab moves money between "still held" and "ready to send
 * you". The Payments tab went on showing the old numbers until a full page reload — on the one
 * screen where a stale number is a person's money.
 *
 * **Re-fetching the page and lifting this panel out of it, rather than a JSON endpoint and a
 * renderer here.** A second renderer for these tables is the `project_client_renderer_i18n_drift`
 * class in its purest form: two copies of the same rows, one of which stops matching the other's
 * wording, on a money screen. The server already renders this panel correctly; asking it again
 * costs one request on a tab the seller has just opened after changing something, which is rare,
 * and it cannot drift by construction.
 *
 * It runs on REVEAL, not on the mutation: refreshing a hidden panel spends a request nobody is
 * waiting for, and refreshing the visible one under the seller's cursor is the thing `tab-sync.ts`
 * refuses to do everywhere else.
 */
async function refreshPayoutsPanel(): Promise<void> {
  const root = document.getElementById('payouts-root');
  if (!root) return;
  const url = new URL(window.location.href);
  url.searchParams.set('panel', 'payouts');
  const res = await fetch(url.toString(), { headers: { 'X-Requested-With': 'fetch' } });
  if (!res.ok) throw new Error(`payouts refresh: ${res.status}`);
  const fresh = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('payouts-root');
  if (!fresh) throw new Error('payouts refresh: panel missing from the response');
  root.replaceWith(fresh);
  // The form is new markup, so its handler has to be attached again. Idempotent by construction —
  // the old element is gone, and with it every listener that was on it.
  initPayoutsTab();
}

export function initPayoutsTab(): void {
  const form = document.getElementById('pay-details-form') as HTMLFormElement | null;
  const save = document.getElementById('pay-details-save') as HTMLButtonElement | null;
  const error = document.getElementById('pay-details-error');
  if (!form || !save || !error) return;

  /**
   * "Fill in the details" → the first field that is actually empty, focused.
   *
   * It was `href="#pay-details-form"`, and an anchor jump puts the TARGET's top at the VIEWPORT's
   * top — under this site's fixed header, and above the heading and hint the form opens with. The
   * owner landed in the middle of the inputs (2026-08-10). `scrollRowBackIntoView` is the house
   * helper that knows about the fixed header and the sticky strip, and it does nothing at all when
   * the target is already on screen (`feedback_subtle_scroll`: a control that moves the page when
   * it did not need to teaches people not to press it).
   *
   * The first EMPTY field rather than the form: a seller pressing this has come to type, and the
   * box they must type in first is the only thing on that card they need.
   */
  document.getElementById('pay-goto-details')?.addEventListener('click', () => {
    const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));
    const target = fields.find((f) => !f.value) ?? fields[0];
    if (!target) return;
    scrollRowBackIntoView(target);
    target.focus({ preventScroll: true });
  });

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

/**
 * Wire the staleness watch — ONCE per page, unlike `initPayoutsTab`, which re-runs on every
 * refresh because it binds the form that was just replaced.
 *
 * `dash:mutated` comes from the fetch observer in `tab-sync.ts` (its header says why it lives
 * there and not at twenty call sites). Only order mutations matter: nothing else on this dashboard
 * moves a shekel between held and payable.
 *
 * `registerPanelRefresh` hands the same function to the cross-TAB path, so a change made in another
 * browser tab updates this panel by exactly the same route rather than by a second one.
 */
export function watchPayoutsFreshness(): void {
  const panel = document.getElementById('dash-panel-payouts');
  if (!panel) return;
  let stale = false;

  registerPanelRefresh('dash-panel-payouts', refreshPayoutsPanel);

  window.addEventListener('dash:mutated', (e) => {
    const path = (e as CustomEvent<{ path?: string }>).detail?.path ?? '';
    if (!path.startsWith('/api/seller/orders')) return;
    // Visible right now — the seller is looking at these numbers, so correct them immediately.
    // Hidden — wait for the reveal rather than spending a request on a panel nobody is reading.
    if (!panel.hidden) void refreshPayoutsPanel().catch(() => { stale = true; });
    else stale = true;
  });

  panel.addEventListener('dashtab:show', () => {
    if (!stale) return;
    stale = false;
    // Failure leaves the panel as it was and re-arms, rather than blanking numbers or claiming
    // figures it could not fetch. The next reveal tries again.
    void refreshPayoutsPanel().catch(() => { stale = true; });
  });
}
