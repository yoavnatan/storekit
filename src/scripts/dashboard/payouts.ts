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
import { scrollBelowPinnedChrome } from './scroll-utils.js';
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
   * "Fill in the details" → the details CARD parked at the top of the readable area, with the first
   * empty field focused.
   *
   * Two wrong versions before this one, and both are worth recording because they are the two ways
   * this goes wrong. It started as `href="#pay-details-form"`: an anchor jump puts the target's top
   * at the VIEWPORT's top, which on this site is underneath the fixed header, so it landed in the
   * middle of the inputs. Then it scrolled to the first empty FIELD through `scrollRowBackIntoView`
   * — which does nothing when the target is already on screen, and the form sits directly under the
   * banner, so pressing the button moved nothing at all (owner, 2026-08-10).
   *
   * `scrollBelowPinnedChrome` is the right helper: it parks the element's top just below the pinned
   * chrome and it always moves. The element is the CARD, not the field — the seller asked to be
   * taken to the section, and a section whose heading and hint are off screen has not been arrived
   * at. The focus still goes to the first empty box, with `preventScroll` so the browser's own
   * focus scrolling cannot undo the placement.
   */
  document.getElementById('pay-goto-details')?.addEventListener('click', () => {
    scrollBelowPinnedChrome(form);
    const fields = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));
    (fields.find((f) => !f.value) ?? fields[0])?.focus({ preventScroll: true });
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
      //
      // All THREE marks come down together, and that is the point of the chain (owner, סשן א׳ §5):
      // the banner, the dot on the form's own heading, and the dot on the tab in the strip. They
      // are one server-rendered condition, so a save that cleared only the one the seller happened
      // to be looking at would leave the other two pointing at a form that is now filled in — the
      // dead end this whole change is about. The avatar dot in the site header is not touched from
      // here: it re-reads `/api/seller/alerts` on its own 30s poll, and reaching across into
      // another component's markup is how two owners of one indicator start disagreeing.
      //
      // `bankLine` is the server's answer, not the form's: it is non-null only when all four fields
      // came back as a payable account, so a save of the business fields alone correctly leaves
      // every mark up.
      if (body.bankLine) {
        document.getElementById('pay-no-bank-banner')?.remove();
        document.getElementById('pay-bank-dot')?.remove();
        document.querySelector('#tab-payouts [data-tab-alert]')?.remove();
      }
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

  /**
   * Paging swaps the TABLE, not the page.
   *
   * The pagers are real links so they work with no JS, and followed as links they reload the whole
   * dashboard — 865KB of HTML and every panel's markup, to move one table by ten rows (owner,
   * 2026-08-10). Intercepted here they go through the same panel refresh an order change already
   * uses: the server renders the panel, this swaps `#payouts-root`, and nothing else on the page
   * moves. `pushState` keeps the address bar honest, so a reload or a shared link lands on the same
   * page of the same table.
   *
   * **In here and not in `initPayoutsTab`, and that distinction is a bug this file already made
   * once.** The listener is delegated on `#dash-panel-payouts`, which a refresh does NOT replace —
   * only `#payouts-root` inside it is swapped. Registering it from the function that re-runs after
   * every refresh therefore stacked a second handler on every page turn, so the third click fired
   * four refreshes. Everything bound to markup that gets replaced belongs in `initPayoutsTab`;
   * everything bound to the panel, the window or the document belongs here, once.
   *
   * A refresh that fails falls back to the navigation the link would have done anyway — the seller
   * asked for a page and gets one, slowly, rather than a click that does nothing.
   */
  panel.addEventListener('click', (e) => {
    const link = (e.target as Element | null)?.closest<HTMLAnchorElement>('[data-payouts-pager] a[href]');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(null, '', link.href);
    void refreshPayoutsPanel().catch(() => { window.location.href = link.href; });
  });

  // Back and Forward across the pages the pager pushed. Bound once, for the same reason.
  window.addEventListener('popstate', () => {
    if (!document.getElementById('payouts-root')) return;
    void refreshPayoutsPanel().catch(() => { /* the panel stays as it is; the URL is still honest */ });
  });

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
