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

// A pure leaf module — no database, no request — so importing it into the browser bundle costs the
// composition rule and nothing else. Same split `seller-report-shapes.ts` exists for.
import { businessSummaryLine, type BusinessType } from '../../lib/payout-details.js';
import { showErrorToast } from '../../lib/toast.js';
import { busyButton } from './btn-busy.js';
import { announceValueChange, discardChanges } from './unsaved-guard.js';
import { scrollBelowPinnedChrome } from './scroll-utils.js';
import { registerPanelRefresh } from './tab-sync.js';

interface SaveResponse {
  ok?: boolean; error?: string; field?: string;
  bankLine?: string | null;
  /** The STORED, normalised values — not what was typed. A seller who enters `51-234-5678` has
   *  `512345678` saved, and the summary must show the second. */
  businessId?: string;
  businessType?: string;
}

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
/**
 * The tiles, while a refresh is in flight (owner, 2026-08-11: *"האם יש איזשהו פלייסהולדר/סקלטון
 * יפה ומובן על לשונית תשלומים? כמו שיש בביצועים"*).
 *
 * **The panel is server-rendered, so it has no first-paint wait — and that is why this is the only
 * place a skeleton belongs on it.** Performance shimmers because its numbers are fetched after the
 * page; these arrive WITH the page. What they do not survive is a status change on the Orders tab:
 * that moves money between held and payable, this panel re-reads itself, and until the answer lands
 * the tiles show the figure from before the change — stale money wearing the confidence of fresh
 * money. The rule is `SkelBar.astro`'s, one screen over: a seller cannot tell a value that is not
 * here yet from one that is, so show neither a wrong number nor a blank.
 *
 * The originals are kept so a FAILED refresh puts them back. That matters more here than the
 * shimmer does: `refreshPayoutsPanel` deliberately leaves the panel alone when the request does not
 * arrive (an empty answer and no answer are different facts), and a skeleton left shimmering
 * forever would turn a recoverable failure into a screen that never resolves.
 */
function setPayoutsBusy(root: HTMLElement, busy: boolean): void {
  // The literal string, never `toggleAttribute` — that writes `aria-busy=""`, and an empty value is
  // not one of the two ARIA accepts, so a screen reader is told nothing at all. Same spelling the
  // reports panel already uses.
  if (busy) root.setAttribute('aria-busy', 'true');
  else root.removeAttribute('aria-busy');
  for (const cell of Array.from(root.querySelectorAll<HTMLElement>('[data-skel]'))) {
    if (busy) {
      if (cell.dataset.skelWas === undefined) cell.dataset.skelWas = cell.textContent ?? '';
      const bar = document.createElement('span');
      // `.skel-bar` is the site's one shimmer (utilities/utils.css); the sizing utilities come from
      // the attribute so the bar matches the value it stands in for and the swap does not jump.
      bar.className = `skel-bar inline-block align-middle ${cell.dataset.skel ?? ''}`;
      bar.setAttribute('aria-hidden', 'true');
      cell.replaceChildren(bar);
    } else if (cell.dataset.skelWas !== undefined) {
      cell.textContent = cell.dataset.skelWas;
      delete cell.dataset.skelWas;
    }
  }
}

async function refreshPayoutsPanel(): Promise<void> {
  const root = document.getElementById('payouts-root');
  if (!root) return;
  setPayoutsBusy(root, true);
  const url = new URL(window.location.href);
  url.searchParams.set('panel', 'payouts');
  let fresh: HTMLElement | null;
  try {
    const res = await fetch(url.toString(), { headers: { 'X-Requested-With': 'fetch' } });
    if (!res.ok) throw new Error(`payouts refresh: ${res.status}`);
    fresh = new DOMParser().parseFromString(await res.text(), 'text/html').getElementById('payouts-root');
    if (!fresh) throw new Error('payouts refresh: panel missing from the response');
  } catch (err) {
    // Put the numbers back before rethrowing: every caller treats a rejection as "leave the panel as
    // it was and try again later", and a panel left in its busy state is not as it was.
    setPayoutsBusy(root, false);
    throw err;
  }
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
   * ── The closed bank summary ↔ the open form (owner, סשן א׳ §2) ──
   *
   * **A visibility toggle, not a renderer.** Both halves are in the server's markup with `hidden`
   * on the one that does not apply, so the first paint is already right and there is no second
   * copy of a money form living in a template literal here. All this does is swap which is hidden.
   *
   * `hidden` and not a class: `reset.css` gives `[hidden]` an `!important` display:none, which is
   * the one rule that cannot be lost to a `display:flex` further up the cascade — the
   * `project_tailwind_hidden_vs_flex` trap, on markup that is inside a `.card` (a flex column).
   */
  const summary = document.getElementById('pay-bank-summary');
  const fields = document.getElementById('pay-bank-fields');
  function showFields(open: boolean): void {
    // Only meaningful when there IS a summary — a seller with no bank on file has no closed state
    // to return to, and the fields must never be hidden from them.
    if (!summary || !fields) return;
    summary.hidden = open;
    fields.hidden = !open;
  }
  document.getElementById('pay-bank-edit')?.addEventListener('click', () => {
    showFields(true);
    form!.querySelector<HTMLInputElement>('#pay-bank-code')?.focus();
  });
  document.getElementById('pay-bank-cancel')?.addEventListener('click', () => {
    /**
     * Back to the LAST SAVE, and `discardChanges` rather than `form.reset()` — which is the whole
     * point and was a real bug in the first version of this handler.
     *
     * `form.reset()` restores each input's `value` ATTRIBUTE, i.e. what the server rendered when
     * the page loaded. This form saves over `fetch` and never reloads, so after one save those
     * attributes are stale: edit account A to account B, save, press ערוך, press ביטול, and the
     * inputs go back to **A** while the summary above them says **B**. The next save would then
     * post A and silently move the seller's payouts back to an account they had replaced —
     * `record-rev.ts`'s rule ("a save must never revert a field the seller did not touch"),
     * reached from the other direction.
     *
     * `unsaved-guard.ts` already owns the correct baseline: it retakes one on every `dash:saved`,
     * which the submit handler below fires. So "cancel" means exactly what "discard" means
     * everywhere else on this dashboard, and there is one definition of it rather than two.
     */
    discardChanges(form!);
    error!.classList.add('hidden');
    showFields(false);
  });

  /**
   * "פרטים נוספים" → the rules block at the bottom of the panel (owner, §3).
   *
   * A real `<a href="#pay-how">` in the markup, so it works with no JS, intercepted here for the
   * same reason the "fill in your details" button is not an anchor: an anchor jump parks the
   * target's top at the VIEWPORT's top, which on this site is underneath the fixed header.
   * `scrollBelowPinnedChrome` clears it.
   */
  document.getElementById('pay-how-link')?.addEventListener('click', (e) => {
    const target = document.getElementById('pay-how');
    if (!target) return;
    e.preventDefault();
    scrollBelowPinnedChrome(target);
  });

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
    // Defensive: the banner only renders when there is NO payable bank, so the fields are already
    // open. Opening them anyway costs nothing and means the button can never scroll a seller to a
    // collapsed summary and focus something they cannot see.
    showFields(true);
    scrollBelowPinnedChrome(form);
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));
    (inputs.find((f) => !f.value) ?? inputs[0])?.focus({ preventScroll: true });
  });

  /**
   * ── The bank picker ──
   *
   * Search by name or by code, pick, and the input keeps the CODE — which is what PayMe take and
   * what the form posts. The list is read off the input's own `data-banks`, so the browser and the
   * server are looking at one copy of it rather than two that can drift.
   *
   * It never refuses an unlisted code (`lib/israeli-banks.ts` says why); it just shows no name.
   */
  const bankInput = document.getElementById('pay-bank-code') as HTMLInputElement | null;
  const bankList = document.getElementById('pay-bank-list');
  const bankLabel = document.getElementById('pay-bank-name');
  if (bankInput && bankList && bankLabel) {
    interface Bank { code: string; name: string }
    let banks: Bank[] = [];
    try { banks = JSON.parse(bankInput.dataset['banks'] ?? '[]') as Bank[]; } catch { banks = []; }
    const norm = (v: string): string => v.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const nameOf = (code: string): string => banks.find((b) => b.code === norm(code))?.name ?? '';

    const closeList = (): void => {
      bankList.classList.add('!hidden');
      bankInput.setAttribute('aria-expanded', 'false');
    };

    const render = (query: string): void => {
      const q = query.trim();
      const digits = norm(q);
      const hits = !q ? banks : banks.filter((b) => b.name.includes(q) || (!!digits && b.code.startsWith(digits)));
      if (!hits.length) { closeList(); return; }
      bankList.replaceChildren(...hits.map((b) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.className = 'w-full text-start rounded-[var(--radius-sm)] py-[0.45rem] px-[0.75rem] text-[0.85rem] hover:[background:var(--color-bg)] cursor-pointer bg-transparent border-0';
        row.textContent = `${b.name} · ${b.code}`;
        // `mousedown`, not `click`: `blur` fires first on a click and would close the list before
        // the pick landed — the same ordering trap every dropdown on this site has to answer.
        row.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          bankInput.value = b.code;
          bankLabel.textContent = b.name;
          closeList();
          // Through the ONE announcer, never a hand-rolled `input` event: a widget that writes into
          // a field without firing one leaves the unsaved-changes guard believing nothing moved,
          // and `tests/unsaved-notice.test.ts` scans for exactly this.
          announceValueChange(bankInput);
        });
        return row;
      }));
      bankList.classList.remove('!hidden');
      bankInput.setAttribute('aria-expanded', 'true');
    };

    bankInput.addEventListener('focus', () => render(bankInput.value));
    bankInput.addEventListener('input', () => {
      bankLabel.textContent = nameOf(bankInput.value);
      render(bankInput.value);
    });
    bankInput.addEventListener('blur', () => window.setTimeout(closeList, 0));
    bankInput.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeList(); });

    /**
     * ── The name is a PICTURE of the field, so it repaints when the field is rewritten ──
     *
     * This widget keeps its state in the input and its readable half in a sibling — exactly the
     * shape that breaks when the form replaces the field underneath it (a draft restore, a panel
     * swap). Four widgets were missing this listener in the 2026-08-09 sweep and the symptom each
     * time was the same: the value came back and the picture did not. `field-repaint-guard` scans
     * for `announceValueChange` without this listener, which is how it was caught here too.
     */
    window.addEventListener('dash:fieldsrewritten', () => {
      bankLabel.textContent = nameOf(bankInput.value);
      closeList();
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = i18n();
    error.classList.add('hidden');

    const data = new FormData(form);

    /**
     * ── Nothing typed is not something to save ──
     *
     * Owner, 2026-08-25: *"אפשר לעשות שם כרגע שמור פרטים למרות שלא הוזנו שם פרטים בכלל"*. An empty
     * submit reached the server, wrote nothing, and answered "saved" — a confirmation for an act
     * that did not happen, on the screen where a seller is deciding whether to trust us with an
     * account number. The server refuses it too; this is the half that names the field.
     */
    if (![...data.values()].some((v) => String(v).trim() !== '')) {
      error.textContent = t['payDetailsEmpty'] ?? '';
      error.classList.remove('hidden');
      form.querySelector<HTMLElement>('[name="bankCode"]')?.focus();
      return;
    }

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

      /**
       * ── The confirmation belongs IN the button ──
       *
       * Owner, 2026-08-25: *"השמירת פרטים פותחת טוסט של 'הפרטים נשמרו' בעוד שמתבקש שזה יהיה בכלל
       * בתוך הכפתור שמירה"*. A toast for a save the seller is looking straight at travels to the
       * corner of the screen to report something that happened under his cursor. `btn--confirmed`
       * is this site's existing recipe for exactly that (`components/buttons.css`), so the button
       * he pressed says it and settles back.
       */
      busy.confirm(t['payDetailsSaved'] ?? 'Saved');
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

      /**
       * Back to the closed summary, carrying the account the SERVER just stored (owner, §2).
       *
       * `bankLine` is non-null only when all four fields came back as a payable account, so a save
       * of the business fields alone correctly leaves the form open. The summary markup is always
       * present (hidden when there was no account), which is what lets a seller who has just filled
       * this in for the FIRST time land on the closed card without a reload — and why the cancel
       * button has to be un-hidden here rather than only rendered when the page loaded with one.
       *
       * The values come from the response and never from the form: the server normalises what was
       * typed (`51-234-5678` is stored as `512345678`), and a summary built from the inputs would
       * describe something slightly different from what is on file.
       */
      if (body.bankLine && summary) {
        const line = document.getElementById('pay-bank-summary-line');
        if (line) line.textContent = body.bankLine;
        const business = document.getElementById('pay-business-summary');
        if (business) {
          business.textContent = businessSummaryLine(
            { businessId: body.businessId || undefined, businessType: body.businessType as BusinessType || undefined },
            { exempt: t['payBusinessExempt'] ?? '', licensed: t['payBusinessLicensed'] ?? '', company: t['payBusinessCompany'] ?? '' },
            t['payBusinessMissing'] ?? '',
          );
        }
        const cancel = document.getElementById('pay-bank-cancel');
        if (cancel) cancel.hidden = false;
        showFields(false);
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
   * Nothing on this panel pages any more.
   *
   * The delegated pager handler that used to live here — and the `popstate` listener beside it —
   * went with the payout-history table, which moved to the Reports tab as the `payouts` report
   * (owner, סשן א׳ §6). Worth recording rather than silently deleting, because the bug it carried
   * generalises: it was delegated on `#dash-panel-payouts`, which a refresh does NOT replace (only
   * `#payouts-root` inside it is swapped), so registering it from `initPayoutsTab` — which re-runs
   * after every refresh — stacked a handler per page turn. **Everything bound to markup that gets
   * replaced belongs in `initPayoutsTab`; everything bound to the panel, the window or the document
   * belongs here, once.**
   */
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
