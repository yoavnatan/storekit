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
import { fetchOwnCardConfig, loadCardFields } from '../checkout-card.js';

interface StartResponse {
  ok?: boolean; error?: string; payUrl?: string; published?: string[];
  /** Present when the card was accepted but PayMe could not be asked to open the account: something
   *  they require is still not held. It is all on this same tab — the bank block above, or the
   *  business form in step 1 — which is why this is a sentence and not an error. */
  stillMissing?: string[];
}

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

  // ── Opening the chooser on a shop that is already live ────────────────────────────────────
  // On the go-live step the pills are simply there — choosing is the errand. On the card of a
  // running subscription they start closed: that card's job is to say the subscription is running,
  // and four pills standing open under it read as a decision being asked for. The pills themselves
  // are the same element with the same handler either way (`PlanPills.astro`).
  const planToggle = document.getElementById('sub-plan-toggle');
  const planPicker = document.getElementById('sub-plan-picker');
  const openPlans = (): void => {
    planPicker?.classList.remove('!hidden');
    planToggle?.setAttribute('aria-expanded', 'true');
    // `block: 'nearest'` — the smallest scroll that makes it visible, never a jump to the top of
    // the viewport (`feedback_subtle_scroll`).
    planPicker?.scrollIntoView({ block: 'nearest' });
  };
  // The retention step's "move to a cheaper plan" is the same action as the toggle, reached from
  // inside the cancel dialog.
  for (const btn of document.querySelectorAll('[data-open-plans]')) btn.addEventListener('click', openPlans);
  planToggle?.addEventListener('click', () => {
    // `!hidden` and not `hidden`: the picker sits in a flex context, where Tailwind's `hidden`
    // loses to `display:flex` on specificity (`project_tailwind_hidden_vs_flex`).
    const opening = planPicker?.classList.contains('!hidden') ?? false;
    planPicker?.classList.toggle('!hidden', !opening);
    planToggle.setAttribute('aria-expanded', String(opening));
  });

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

        /**
         * ── Repainted, not reloaded (owner, 2026-08-25) ──
         *
         * *"עדיין ללחוץ על שינוי מסלול שם מרענן את כל העמוד."* — and a full reload for a one-click
         * choice is the heaviest possible answer: the seller loses his scroll position, the card
         * iframes are torn down and re-drawn by PayMe's SDK, and any half-typed card number goes
         * with them. On the one screen whose whole job is to get a card typed.
         *
         * A plan change moves exactly three things on this screen, so exactly three are written:
         * which pill is filled, the commission percent, and the amount the tokenizer will quote.
         * Everything else on the card — the VAT note, the breakdown, the next-charge date — is
         * unaffected by WHICH plan this shop is on.
         */
        for (const other of plans.querySelectorAll<HTMLButtonElement>('[data-role="plan"]')) {
          const mine = other === btn;
          other.classList.toggle('btn--accent', mine);
          other.classList.toggle('btn--ghost', !mine);
        }
        const commission = document.getElementById('sub-commission');
        if (commission && btn.dataset['commission']) commission.textContent = `${btn.dataset['commission']}%`;
        // What the card issuer's confirmation screen will say. Read by `tokenize` at press time, so
        // writing it here is what keeps that figure and the marked pill the same fact.
        // Looked up at click time rather than closed over: the card box is declared further down
        // this file, and a handler that reaches backwards for it would depend on the order two
        // unrelated blocks happen to sit in.
        const box = document.getElementById('sub-card-fields');
        if (box && btn.dataset['fee']) box.dataset['amount'] = Number(btn.dataset['fee']).toFixed(2);

        showToast(body.fromNextCharge ? (t['subPlanFromNextCharge'] ?? '') : (t['subPlanSaved'] ?? ''));
      } catch {
        showErrorToast(t['subFailed'] ?? '');
      } finally {
        busy.done();
      }
    });
  });

  // ── The card, typed here rather than on PayMe's page ──────────────────────────────────────
  //
  // **Nothing is charged by this.** The token is stored and the first charge fires when the shop
  // actually goes live (`lib/subscription-arm.ts`), which is what lets a seller commit during
  // PayMe's seven-day review without paying for it.
  //
  // Drawn only after the server says it can be: the key belongs to OUR merchant and a deployment
  // that opened its account without keeping it has no way to draw a field at all. Whichever of the
  // two routes is real is un-hidden here, so a seller never sees both an empty card form and a
  // button that leaves the site.
  const fieldsBox = document.getElementById('sub-card-fields');
  const fallbackBox = document.getElementById('sub-hosted-fallback');
  const saveCard = document.getElementById('sub-card-save') as HTMLButtonElement | null;

  if (fieldsBox && saveCard) {
    void (async () => {
      const config = await fetchOwnCardConfig();
      if (!config.active) { fallbackBox?.classList.remove('!hidden'); return; }
      try {
        const lang = document.documentElement.lang === 'en' ? 'en' : 'he';
        const fields = await loadCardFields(config, lang);
        /**
         * **Mounted either way, revealed only when there is nothing on file.**
         *
         * PayMe's iframes have to be mounted to be typed into, and mounting them is what proves the
         * SDK works at all — the fallback below depends on that answer. But a seller who already
         * has a card should not meet an empty card form: `data-collapsed` says so, and the replace
         * button is what opens it (`SubscriptionCard.astro`).
         */
        if (fieldsBox.dataset['collapsed'] !== 'true') fieldsBox.classList.remove('!hidden');
        saveCard.addEventListener('click', async () => {
          error?.classList.add('hidden');
          const busy = busyButton(saveCard, saveCard.textContent?.trim() ?? '');
          try {
            // Their `tokenize` wants a total, and this one is honest rather than cosmetic: it is
            // what the standing order will charge, so a card issuer's own confirmation screen shows
            // the seller the same figure the card page does. Read off the box's own data, which the
            // plan pills rewrite when the choice changes.
            const token = await fields.tokenize({
              firstName: fieldsBox.dataset['firstName'] ?? '',
              lastName: fieldsBox.dataset['lastName'] ?? '',
              email: fieldsBox.dataset['email'] ?? '',
              phone: fieldsBox.dataset['phone'] ?? '',
              label: fieldsBox.dataset['label'] ?? '',
              amountIls: fieldsBox.dataset['amount'] ?? '0',
            });
            const data = await post({ action: 'save-card', token, storeId: saveCard.dataset['store'] ?? '' });
            if (!data.ok) { fail(data.error === 'no-store-to-bill' ? t['subNoStore'] : undefined); return; }
            /**
             * The card saved — and, sometimes, that is not the whole story. PayMe cannot be asked
             * to open the clearing account until they hold the bank block and the business type as
             * well as the business form, and this screen deliberately lets a card be saved before
             * all of them are in. A plain "card saved" there is true and misleading: it is what the
             * owner met on 2026-08-25, tick and all, with nothing at PayMe.
             *
             * The reload below then re-renders the screen honestly — step 1 open, the wait not
             * started — so this line only has to say WHY, once, out loud.
             */
            showToast(data.stillMissing?.length
              ? (t['subCardSavedIncomplete'] ?? '')
              : (t['subCardSaved'] ?? ''));
            // Re-read rather than repainted: saving the card changes which step of the go-live
            // screen is open, and rebuilding that by hand is how a screen starts disagreeing with
            // the server about where somebody stands. (A PLAN change is the opposite case — it
            // moves three known values and must not throw away a half-typed card.)
            window.location.reload();
          } catch (err) {
            /**
             * A refused card is the seller's to fix and he has to be told, out loud — a silent
             * failure here is a seller who believes he is committed and is not.
             *
             * **And PayMe's own reason is shown**, because ours could not tell a declined card from
             * a detail we failed to send: an empty phone came back looking exactly like a bad card
             * (owner, 2026-08-25), and the generic sentence sent him to re-check digits that were
             * fine. Their text is written for a MERCHANT, which is who is reading this screen — the
             * rule that it must never reach a shopper is about the checkout, not here.
             */
            const said = err instanceof Error ? err.message.replace(/^payme: /, '') : '';
            fail(said ? `${t['subCardRefused'] ?? ''} ${said}`.trim() : t['subCardRefused']);
          } finally {
            busy.done();
          }
        });
      } catch {
        // The SDK did not load or would not mount. The other route still works, so it is offered
        // rather than reported: the seller's errand is putting a card on file, not hearing about
        // a script.
        fallbackBox?.classList.remove('!hidden');
      }
    })();
  } else if (fallbackBox) {
    fallbackBox.classList.remove('!hidden');
  }

  /**
   * ── Replacing a saved card ──
   *
   * The same errand from the top — the server overwrites the token — so it opens the same form
   * rather than being a second, subtly different path.
   *
   * **It used to navigate to `?panel=payouts&card=1`, and nothing in the codebase read `card=1`**
   * (owner, 2026-08-25: *"החלפת כרטיס לא עובד"*). The page reloaded into the identical state, so
   * pressing it did nothing at all and looked like a broken button rather than a missing feature.
   * The fields are on the page now — mounted, collapsed — and this reveals them.
   */
  const cardReplace = document.getElementById('sub-card-replace');
  cardReplace?.addEventListener('click', () => {
    fieldsBox?.classList.remove('!hidden');
    cardReplace.setAttribute('aria-expanded', 'true');
    // `block: 'nearest'` — the smallest scroll that brings it into view, never a jump
    // (`feedback_subtle_scroll`).
    fieldsBox?.scrollIntoView({ block: 'nearest' });
  });

  /**
   * ── Taking the card away again ──
   *
   * Only ever offered on a card that has NOT been charged (`SubscriptionCard.astro` renders the
   * button in that state alone). It was the one point in the flow where a seller had committed and
   * had no way back that did not involve deleting his shop.
   *
   * A modal rather than a `confirm()`: this project does not use the browser's dialogs, and the
   * sentence needs to say the consequence — the shop will not go live — which a one-line confirm
   * cannot carry.
   */
  const cardRemove = document.getElementById('sub-card-remove') as HTMLButtonElement | null;
  cardRemove?.addEventListener('click', () => {
    // The project's own dialog, opened by event — the same one the lifecycle buttons use. Not
    // `confirm()`, which this site does not use anywhere, and which could not carry the sentence
    // that matters: the shop will not go live without a card.
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title: t['subCardRemoveTitle'] ?? '',
        message: t['subCardRemoveBody'] ?? '',
        okLabel: t['subCardRemove'] ?? '',
        tone: 'danger',
        onConfirm: () => void (async () => {
          const busy = busyButton(cardRemove, cardRemove.textContent?.trim() ?? '');
          try {
            const data = await post({ action: 'remove-card' });
            if (!data.ok) { fail(); return; }
            showToast(t['subCardRemoved'] ?? '');
            // Re-read: removing the card moves which go-live step is open and what the overview
            // says, and rebuilding that by hand is how a screen starts disagreeing with the server.
            window.location.reload();
          } catch {
            fail();
          } finally {
            busy.done();
          }
        })(),
      },
    }));
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
