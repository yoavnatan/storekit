// Seller dashboard → "תשלומים" tab → the seller's OWN clearing account
// (components/dashboard/OwnClearingCard.astro).
//
// One save over `fetch`, page updated in place, no reload (memory `feedback_ajax_forms`). A separate
// module and a separate form from `payouts.ts` and `merchant-kyc.ts`, for the same reason those two
// are separate from each other: they post to different routes and save independently.
//
// **The server is the only validator**, and here that is stronger than a preference. Which fields a
// provider needs lives in `clearing-providers.ts`, and a client copy of that list is a copy that
// silently stops matching the day a provider adds a field — the seller would then be told he is
// finished while the route knows he is not. So nothing here decides what is missing; the response
// says, and this renders it.
//
// **A secret is never read back into the page.** The inputs for secrets are rendered empty and are
// only sent when the seller actually types one — that is what makes `saveSellerClearing`'s merge
// the correct behaviour rather than a convenience, and it is why this module posts the form as-is
// instead of "filling in" what is already on file.
import { showToast, showErrorToast } from '../../lib/toast.js';
import { showFieldError, clearFieldError, isValidatableField } from '../../lib/field-validity.js';
import { busyButton } from './btn-busy.js';
import { announceValueChange, discardChanges } from './unsaved-guard.js';

interface ClearingState {
  provider: string | null;
  fields: Record<string, { set: boolean; hint: string }>;
  missing: string[];
  verified: string | null;
  canTakePayments: boolean;
  error?: string;
  field?: string;
}

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initOwnClearingCard(): void {
  const root = document.getElementById('own-clearing');
  const form = document.getElementById('own-clearing-form') as HTMLFormElement | null;
  if (!root || !form) return;

  // Captured after the guard above so the rest of the file has non-null values: TypeScript's
  // narrowing from `if (!root || !form) return;` does not reach into a function declared later.
  const cardEl = root;
  const formEl = form;

  const t = i18n();
  const providerInput = document.getElementById('own-clearing-provider') as HTMLInputElement;
  const summary = document.getElementById('own-clearing-summary');
  const summaryLine = document.getElementById('own-clearing-summary-line');
  const errorLine = document.getElementById('own-clearing-error');
  const cancelBtn = document.getElementById('own-clearing-cancel');
  const stateLine = document.getElementById('own-clearing-state');
  const clearBtn = document.getElementById('own-clearing-clear');
  /** What the SERVER rendered — i.e. the provider actually stored, as against one merely picked in
   *  this session. The difference decides whether clearing is an undo or a deletion. */
  const savedProvider = providerInput.value;

  const pickButtons = (): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('#own-clearing-pick [data-provider]'));
  const fieldsets = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-provider-fields]'));

  /** The provider buttons' names, so the summary can be rebuilt without a reload.
   *
   *  Matched by reading `dataset` rather than by interpolating the id into a selector. A provider id
   *  is our own slug and could not break one — but `CSS.escape` is the only correct way to write
   *  that selector, it does not exist in jsdom, and a helper that throws under test is a helper
   *  nobody can cover. Filtering a list needs no escaping at all, so the sink is removed rather than
   *  guarded. */
  const nameOf = (id: string): string =>
    pickButtons().find((b) => b.dataset.provider === id)?.textContent?.trim() ?? id;

  // ── Picking a provider ──────────────────────────────────────────────────────
  /** Draw the picker FROM the hidden field — never from what was just clicked. That is what makes
   *  the same function serve a press and a repaint, and the repaint is not optional: this widget
   *  keeps its state in a field and its picture in the DOM, which is exactly the shape
   *  `tests/field-repaint-guard.test.ts` exists for. "בטל שינויים" and a recovered draft both
   *  replace fields from outside and fire `dash:fieldsrewritten`; a picker that ignored it would
   *  show one provider over another provider's fields, and the next save would post the one the
   *  seller cannot see. */
  function paintPicker(): void {
    const id = providerInput.value;
    pickButtons().forEach((btn) => {
      const on = btn.dataset.provider === id;
      btn.classList.toggle('btn--accent', on);
      btn.classList.toggle('btn--ghost', !on);
      btn.setAttribute('aria-pressed', String(on));
    });
    fieldsets().forEach((box) => { box.hidden = box.dataset.providerFields !== id; });
    // The row that says it in words. A filled pill among six is a state a reader has to find; the
    // one that matters most — none chosen — has no pill to find at all.
    if (stateLine) {
      stateLine.textContent = id
        ? (t.ownClearingChosen ?? '').replace('{name}', nameOf(id))
        : (t.ownClearingNone ?? '');
      stateLine.classList.toggle('[color:var(--color-muted)]', !id);
    }
    if (clearBtn) clearBtn.hidden = !id;
  }

  /** Choose, or un-choose. Writing the field and repainting from it is the whole operation — the
   *  same path a press, a clear and a `dash:fieldsrewritten` all take, so none of them can leave a
   *  pill lit over another provider's fields. */
  function choose(id: string): void {
    if (providerInput.value === id) return;
    providerInput.value = id;
    paintPicker();
    errorLine?.classList.add('hidden');
    // A mark belongs to the provider that WAS chosen. The new one has been asked nothing yet, so it
    // starts unmarked rather than inheriting somebody else's answer.
    fieldsets().forEach((box) => box.querySelectorAll<HTMLInputElement>('input')
      .forEach((input) => { if (isValidatableField(input)) clearFieldError(input); }));
    announceValueChange(providerInput);
  }

  // The press has to MOVE something, or it reads as a broken field — the no-op this site bans
  // (`feedback_noop_interactions_invisible`). It moves three things: the pressed button's fill, the
  // visible fieldset, and the hidden input the form actually submits. `aria-pressed` stays beside
  // the fill, because colour alone is never a state.
  // Pressing the chosen one again UN-chooses it (owner, 2026-09-08: *"אפשרות לבטל בחירה"*). A
  // toggle rather than a one-way select, because a seller who picked the wrong company otherwise
  // has no way back to "I have not decided" — only to a different wrong answer.
  pickButtons().forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.provider!;
      choose(providerInput.value === id ? '' : id);
    });
  });
  /* ── Clearing is only harmless while nothing is stored (owner, 2026-09-08) ──
     *"אם כבר יש חברת סליקה, אני לא רוצה שבטעות מישהו יבטל את הבחירה בצורה קלה מדי"*. Before a save
     it is a local undo of a click and nothing is at stake. Once an account IS connected the same
     press throws away credentials he pasted from another system — so it asks first, and then it
     really disconnects rather than leaving a saved row behind an emptied screen, which is the state
     that would let him believe he had removed something he had not. */
  clearBtn?.addEventListener('click', () => {
    if (savedProvider && providerInput.value === savedProvider) {
      askDisconnect((t.ownClearingClearAsk ?? '').replace('{name}', nameOf(savedProvider)));
      return;
    }
    /* ── Clearing has to put the FIELDS back too, or the bar has nothing to offer ──
       Owner, 2026-09-08: *"יש שינויים שלא שמרת בתשלומים כשמבטלים חברת סליקה, הרי אין שם איך לשמור
       את הביטול"*. Un-choosing wrote `provider = ''` and left whatever he had typed sitting in the
       now-hidden fieldset, so the form still differed from its baseline — and the unsaved-changes
       bar fired over a state that CANNOT be saved, because a save needs a provider.
       `discardChanges` is the right tool and not a bigger hammer: it restores the whole form to
       what the page rendered, which for a shopper who has chosen nothing is exactly "no provider,
       no values" — the state he just asked for. It also fires `dash:fieldsrewritten`, so the picker
       repaints from the field like any other rewrite. */
    discardChanges(formEl);
    errorLine?.classList.add('hidden');
    fieldsets().forEach((box) => box.querySelectorAll<HTMLInputElement>('input')
      .forEach((input) => { if (isValidatableField(input)) clearFieldError(input); }));
  });

  form.addEventListener('dash:fieldsrewritten', paintPicker);

  // ── Editing an already-connected account ────────────────────────────────────
  document.getElementById('own-clearing-edit')?.addEventListener('click', () => {
    if (summary) summary.hidden = true;
    form.hidden = false;
    form.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([hidden])')?.focus();
  });

  // ── Disconnecting an account that is already stored ──
  // A different act from clearing the choice, and it is asked for: this DELETES what he pasted.
  // Through `ConfirmModal` like every destructive action on this site (native `confirm()` is banned
  // site-wide), and its OK button is danger-red by default, which is right here.
  /** Ask, then delete. One function so the summary's "disconnect" and the form's "clear" cannot
   *  drift into two behaviours for one outcome — they differ only in the question they ask. */
  function askDisconnect(title: string): void {
    window.dispatchEvent(new CustomEvent('confirm:open', {
      detail: {
        title,
        message: t.ownClearingDisconnectBody ?? '',
        okLabel: t.ownClearingDisconnectOk ?? '',
        onConfirm: async () => {
          const res = await fetch('/api/seller/own-clearing', { method: 'DELETE' });
          if (!res.ok) { showErrorToast(t.ownClearingFailed ?? ''); return; }
          const state = await res.json() as ClearingState;
          // Back to the form, with nothing chosen — which is the state he just asked for, and the
          // one the row above the pills now says out loud.
          if (summary) summary.hidden = true;
          formEl.hidden = false;
          providerInput.value = '';
          paintPicker();
          cardEl.querySelectorAll<HTMLInputElement>('#own-clearing-form input:not([type="hidden"])')
            .forEach((input) => { input.value = ''; });
          render(state);
          showToast(t.ownClearingDisconnected ?? '');
        },
      },
    }));
  }

  document.getElementById('own-clearing-disconnect')?.addEventListener('click', () => {
    askDisconnect((t.ownClearingDisconnectAsk ?? '').replace('{name}', nameOf(providerInput.value)));
  });

  cancelBtn?.addEventListener('click', () => {
    discardChanges(form);
    form.hidden = true;
    if (summary) summary.hidden = false;
  });

  // ── Saving ──────────────────────────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    /* ── A press with nothing chosen used to do NOTHING ── (owner, 2026-09-08: *"מה קורה כשלוחצים
       על שמירת פרטי סליקה כשלא בחרתי שום סליקה? כלום"*.) A `return` looks like a guard and reads
       to the person pressing as a dead button — the silent-failure class this repo keeps a
       tree-wide guard for. It says what is missing, in the same line every other refusal on this
       form uses, and puts the focus where the answer is. */
    if (!providerInput.value) {
      if (errorLine) {
        errorLine.textContent = t.ownClearingPickFirst ?? '';
        errorLine.classList.remove('hidden');
      }
      pickButtons()[0]?.focus();
      return;
    }

    const body: Record<string, string> = { provider: providerInput.value };
    // Only the CHOSEN provider's fieldset — the others are rendered and hidden, and sweeping the
    // whole form would post a Hyp terminal number alongside a PayPlus save. The server drops
    // unknown keys (`pickCredentials`), so this is about not lying to it, not about safety.
    const chosen = fieldsets().find((box) => box.dataset.providerFields === providerInput.value);
    chosen?.querySelectorAll<HTMLInputElement>('input')
      .forEach((input) => { if (input.value.trim()) body[input.name] = input.value.trim(); });

    const save = document.getElementById('own-clearing-save') as HTMLButtonElement | null;
    if (!save) return;
    const busy = busyButton(save, t.ownClearingSave ?? 'Save');
    errorLine?.classList.add('hidden');

    try {
      const res = await fetch('/api/seller/own-clearing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const state = await res.json() as ClearingState;

      if (!res.ok || state.error) {
        // Beside the form, not as a toast: the seller is looking at the fields, and the message
        // names one of them.
        if (errorLine) {
          errorLine.textContent = state.error ?? (t.ownClearingFailed ?? '');
          errorLine.classList.remove('hidden');
        }
        if (state.field) form.querySelector<HTMLElement>(`[name="${state.field}"]`)?.focus();
        return;
      }

      /* ── "נשמרו" only when something really is ──
         The button confirmed on every 200, and a save with nothing typed is a 200: it stores the
         chosen provider and reports back that three fields are empty. So the screen said
         *"פרטי הסליקה נשמרו"* over three fields marked in red — seen in the browser, not reasoned
         about. A partial save is still legal and still stored (`feedback_seller_form_burden`); what
         it must not do is claim to be finished. With fields outstanding the marks are the message
         and the button simply settles back. */
      if (state.missing.length) {
        // `dash:saved` and NOT `discardChanges`, for the reason spelled out a few lines down: what
        // he typed WAS stored, so it is the new baseline. Discarding here would throw his two
        // pasted values back to empty on the way to telling him a third is missing.
        window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form: formEl } }));
        render(state);
        return;
      }

      // The confirmation goes IN the button, not into a toast in the corner of a screen the seller
      // is not looking at — the same ruling `payouts.ts` carries for the form directly below this.
      busy.confirm(t.ownClearingSaved ?? 'Saved');
      /* ── `dash:saved`, NOT `discardChanges` — and the difference was a real bug, found by driving
         the screen (2026-09-08) ──
         `discardChanges` restores the baseline `unsaved-guard.ts` took when the page RENDERED, and
         on a first connection that baseline holds `provider=""`. So the save succeeded, the field
         was thrown straight back to empty, the repaint listener fired on it, and every fieldset
         hid — leaving a seller who had just saved two of three fields staring at a form with no
         fields in it and no error anywhere. `dash:saved` is the opposite operation: it tells the
         guard that what is on screen IS the new baseline, which is what a later "cancel" must come
         back to. */
      window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form } }));
      render(state);
    } catch {
      // A network failure is the one case with nothing to say beside a field, so it is the one case
      // that is a toast.
      showErrorToast(t.ownClearingFailed ?? '');
    } finally {
      busy.done();
    }
  });

  /** The server's answer, drawn. Never our own idea of what was saved — the whole reason the route
   *  answers with the full state rather than `{ok:true}`. */
  function render(state: ClearingState): void {
    // A secret the seller just typed must not stay in the DOM after the save: the field is on file
    // now and is rendered as a hint everywhere else, so leaving the plaintext in an input is the
    // one place on this screen a shoulder-surfer or a screen-share could still read it.
    root!.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => { input.value = ''; });

    const settled = !!state.provider && state.missing.length === 0;
    /* ── What is missing is marked ON the fields, the way every other form here marks one ──
       It used to be one sentence counting them: *"חסר עוד 3 שדות כדי שהחנות תוכל לקבל תשלום"*. The
       owner rejected it twice over — the Hebrew, and the fact that it is not how this site reports
       an incomplete form anywhere else (`scripts/form-validity.ts` → `showFieldError`, a message
       under the field itself, focus on the first one). A count also leaves him hunting for WHICH
       three among six.
       Partial saves stay legal, which is why the fields are not `required`: he pastes what he has,
       and what he has not is marked rather than refused (`feedback_seller_form_burden`). */
    const chosen = fieldsets().find((box) => box.dataset.providerFields === state.provider);
    chosen?.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      if (!isValidatableField(input)) return;
      if (state.missing.includes(input.name)) showFieldError(input, t.fieldRequired ?? '');
      else clearFieldError(input);
    });
    if (settled) {
      if (summaryLine && state.provider) {
        summaryLine.textContent = (t.ownClearingOnFile ?? '').replace('{name}', nameOf(state.provider));
      }
      if (summary) summary.hidden = false;
      if (cancelBtn) cancelBtn.hidden = false;
      form!.hidden = true;
    }
  }
}
