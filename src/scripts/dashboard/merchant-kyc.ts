// Seller dashboard → "תשלומים" tab → the clearing-details form
// (components/dashboard/ClearingDetailsForm.astro).
//
// One save over `fetch`, page updated in place, no reload (`feedback_ajax_forms`). A sibling of
// `payouts.ts` and deliberately not part of it: they post to different routes and the two forms save
// independently, so a seller can fill in his bank today and his ת.ז tomorrow without either save
// depending on the other being complete.
//
// **The server is the only validator, and this file has no copy of any rule.** Not even "which
// fields are required": `missingMerchantKyc` decides, the response carries the answer, and the
// message here is built from that number. A client-side gate would be a second definition of what
// PayMe require — and, worse, it would BLOCK a partial save, which is the one thing this form is not
// allowed to do (`feedback_seller_form_burden`).
import { showToast } from '../../lib/toast.js';
import { busyButton } from './btn-busy.js';
import { announceValueChange } from './unsaved-guard.js';
import { initSelectDropdown } from './select-dropdown.js';
import { showFieldError, clearFieldError, type ValidatableField } from '../../lib/field-validity.js';

interface SaveResponse {
  ok?: boolean;
  error?: string;
  /** Field names still outstanding, from the same function the account-opening path asks. */
  missing?: string[];
  /** What is still holding the shop off the site, straight from `publishHoldsFor` — the same set
   *  the go-live screen was rendered with, so the two can be compared rather than guessed at. */
  holds?: string[];
  /** Slugs that went live in this save — usually empty, and worth a sentence when it is not. */
  published?: string[];
}

/**
 * What SHAPE a rejected field was expected to have.
 *
 * "הערך לא התקבל" was true and useless (owner, 2026-08-24: *"מה זה? ערך שגוי?"*) — it told a seller
 * something was wrong with a value he could see nothing wrong with. These say what was expected
 * instead, per field, for the four that have a format worth naming.
 *
 * **A HINT, never the rule.** `normalizeMerchantKyc` still decides, and it is the only thing that
 * does: nothing here validates, refuses or gates, so it cannot disagree with the server about
 * whether a value is acceptable — only about how to describe what was wanted. A field with no entry
 * here falls back to the generic line.
 */
const REJECTED_KEY: Record<string, string> = {
  ownerSocialId: 'mkErrSocialId',
  ownerPhone: 'mkErrPhone',
  ownerBirthdate: 'mkErrDate',
  ownerSocialIdIssued: 'mkErrDate',
  businessRegisteredOn: 'mkErrDate',
};

function i18n(): Record<string, string> {
  try { return JSON.parse(document.getElementById('i18n-data')?.textContent ?? '{}').dashboard ?? {}; }
  catch { return {}; }
}

export function initMerchantKycForm(): void {
  const form = document.getElementById('mk-form') as HTMLFormElement | null;
  const save = document.getElementById('mk-save') as HTMLButtonElement | null;
  const error = document.getElementById('mk-error');
  if (!form || !save || !error) return;

  // Both halves are in the server's markup with `hidden` on the one that does not apply, so the
  // first paint is already right — the same shape the bank block uses, and for the same reason
  // (`project_injected_overlay_flash`). `hidden` rather than a class because `reset.css` gives it an
  // `!important` display:none, the one rule a `display:flex` further up cannot beat
  // (`project_css_cascade_traps`).
  const summary = document.getElementById('mk-summary');
  const fields = document.getElementById('mk-fields');
  const open = (yes: boolean): void => {
    if (!summary || !fields) return;
    summary.hidden = yes;
    fields.hidden = !yes;
  };
  // The trade picker, when it is rendered at all — only for a shop whose own categories answered
  // nothing (`merchant-category.ts`). A raw `<select>` is banned site-wide; this replaces it with
  // the site's own dropdown and leaves the select as the value.
  const category = document.getElementById('mk-category') as HTMLSelectElement | null;
  if (category) initSelectDropdown(category);
  // The business type moved onto this form on 2026-08-25 and gets the same treatment — it was a raw
  // `<select>` on the bank block, which is a shape this site does not use anywhere else.
  const businessType = form.querySelector<HTMLSelectElement>('#mk-business-type');
  if (businessType) initSelectDropdown(businessType);

  document.getElementById('mk-edit')?.addEventListener('click', () => open(true));
  document.getElementById('mk-cancel')?.addEventListener('click', () => open(false));

  // Gender is two buttons rather than a dropdown of two (and never a raw `<select>`, banned
  // site-wide). Its state lives in a hidden FIELD and its picture in `aria-pressed`, which is
  // exactly the shape that owes both halves of the write/repaint pair — see
  // `tests/field-repaint-guard.test.ts`.
  const genderGroup = document.getElementById('mk-gender');
  const genderValue = document.getElementById('mk-gender-value') as HTMLInputElement | null;

  /** Paint the buttons FROM the field. The one direction, used on a click and on a restore, so the
   *  two can never disagree about which is pressed. */
  const paintGender = (): void => {
    if (!genderGroup || !genderValue) return;
    for (const b of genderGroup.querySelectorAll<HTMLButtonElement>('[data-gender]')) {
      b.setAttribute('aria-pressed', String(b.dataset.gender === genderValue.value && genderValue.value !== ''));
    }
  };

  genderGroup?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-gender]');
    if (!btn || !genderValue) return;
    genderValue.value = btn.dataset.gender ?? '';
    paintGender();
    // A programmatic write to a hidden field, which nothing else would notice — said in the one
    // sanctioned way, so the unsaved-changes bar cannot end up describing a form that has moved.
    announceValueChange(genderValue);
  });

  // The other half of the same rule. "בטל שינויים" and a recovered draft both replace fields from
  // OUTSIDE this widget; without this the buttons would keep showing the old choice while the field
  // held the restored one, and the next save would write what the seller cannot see.
  document.addEventListener('dash:fieldsrewritten', paintGender);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = i18n();
    error.classList.add('hidden');

    const body: Record<string, string> = Object.fromEntries(
      Array.from(new FormData(form).entries()).map(([k, v]) => [k, String(v)]),
    );
    // A blank gender is left out entirely. `normalizeMerchantKyc` would drop `''` anyway, but "he
    // has not answered" and "he chose male" must not arrive as the same request.
    if (!body.ownerGender) delete body.ownerGender;

    const busy = busyButton(save, t['mkSave'] ?? 'Send');
    try {
      const res = await fetch('/api/seller/merchant-kyc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as SaveResponse;
      if (!res.ok || !data.ok) {
        // Beside the form, not as a toast: the seller is looking at the fields.
        error.textContent = data.error ?? (t['mkFailed'] ?? 'Could not save.');
        error.classList.remove('hidden');
        return;
      }

      /**
       * **Mark the fields the server did not accept — from the SERVER's own list.**
       *
       * There is no client-side validation here and there must not be: `normalizeMerchantKyc` is
       * the single definition of what PayMe will take, and a second copy in the browser is a copy
       * that drifts — and would produce the failure `payout-details.ts` warns about at length, a
       * false rejection the seller cannot argue with. So the answer comes back from the same
       * function that decides whether an account may be opened, and this only draws it.
       *
       * **Every missing field is marked, empty ones included** (owner, 2026-08-24: *"אם השדה לא
       * סומן והוא חובה, זה טעות"*). All ten are required before PayMe will open an account, and he
       * pressed SEND — at that moment an empty one is not an unfinished form, it is the reason the
       * thing he asked for did not happen. The first version marked only fields with a value, which
       * left him a count in a toast and nothing on screen to act on.
       *
       * Two messages, because they are two different mistakes: a field he has not filled in, and a
       * field he filled in with something the server dropped. The second is the one that was
       * previously undiscoverable at all.
       */
      const missingNames = new Set(data.missing ?? []);
      for (const field of form.querySelectorAll<ValidatableField>('[name]')) {
        clearFieldError(field);
        if (!missingNames.has(field.name)) continue;
        showFieldError(field, field.value.trim()
          ? (t[REJECTED_KEY[field.name] ?? ''] ?? t['mkFieldRejected'] ?? 'This value was not accepted.')
          : (t['mkFieldRequired'] ?? 'This field is required.'));
      }
      // Straight to the first one, because on a ten-field form the rejected value is usually below
      // the fold by the time he presses send.
      form.querySelector<ValidatableField>('[aria-invalid="true"]')?.focus();

      // What is still outstanding is the SERVER's count, so the sentence can never disagree with the
      // thing that decides whether an account may be opened. Nothing was refused either way — the
      // partial save landed.
      const missing = data.missing?.length ?? 0;
      showToast(missing
        ? (t['mkStillMissing'] ?? 'Saved.').replace('{n}', String(missing))
        : (t['mkSaved'] ?? 'Saved.'));
      window.dispatchEvent(new CustomEvent('dash:saved', { detail: { form } }));

      // Complete, so the fields collapse into the one-line summary — the same closed state the bank
      // block settles into, without a reload.
      if (!missing) open(false);

      /**
       * ── The go-live screen is SERVER-rendered, so a hold that lifted has to be re-read ──
       *
       * Owner, 2026-08-25: *"שום דבר לא משתנה שם בשלבים, השלב נשאר כחול, לא עובר לשלב הבא, היוזר
       * נשאר תקוע, אני הייתי עוזב את האתר."* And he was right: this save is what opens the merchant
       * account, which is what removes the `clearing-details` hold — and every part of that screen
       * that depends on it (which step is open, the state line, "step N of 3", the bar, the tick)
       * is decided on the server. The one thing this handler updated was the form's own summary.
       *
       * Patching the rest by hand would be five parallel renderers of one server decision, which
       * is the drift this project has a rule about. So the page is re-read — but ONLY when the
       * holds really moved, compared against the set the page was rendered with, so an ordinary
       * partial save still costs nothing.
       */
      const rendered = document.getElementById('go-live')?.dataset['holds'];
      const now = (data.holds ?? []).join(',');
      if (rendered !== undefined && rendered !== now) { window.location.reload(); return; }
      // The shop went live in this very request: the seller was waiting on exactly this, and a page
      // that still says "not live" underneath a successful save is the disagreement worth avoiding.
      if (data.published?.length) window.location.reload();
    } catch {
      error.textContent = t['mkFailed'] ?? 'Could not save.';
      error.classList.remove('hidden');
    } finally {
      busy.done();
    }
  });
}
