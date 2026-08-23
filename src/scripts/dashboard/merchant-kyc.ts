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

interface SaveResponse {
  ok?: boolean;
  error?: string;
  /** Field names still outstanding, from the same function the account-opening path asks. */
  missing?: string[];
  /** Slugs that went live in this save — usually empty, and worth a sentence when it is not. */
  published?: string[];
}

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
  // (`project_tailwind_hidden_vs_flex`).
  const summary = document.getElementById('mk-summary');
  const fields = document.getElementById('mk-fields');
  const open = (yes: boolean): void => {
    if (!summary || !fields) return;
    summary.hidden = yes;
    fields.hidden = !yes;
  };
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
