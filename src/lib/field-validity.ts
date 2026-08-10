/**
 * The site's own "this field isn't filled in right" message, replacing the browser's.
 *
 * **What it replaces and why.** Every form outside checkout relied on native constraint
 * validation, so an empty required field produced the browser's own bubble: an OS-styled
 * grey tooltip, in the browser's UI language rather than the page's, positioned by the
 * browser, gone the moment anything else is clicked, and invisible to a screen reader on
 * some engines. On a Hebrew RTL site it was also the one piece of chrome that never looked
 * like the site. Checkout had already been hand-built out of that hole (`novalidate` plus
 * its own `aria-invalid` + `[data-err]` lines); this is that same treatment made general,
 * so a new form gets it without anyone remembering to wire anything.
 *
 * **How it takes over, and why not `novalidate`.** The obvious route is to set `novalidate`
 * on every form and re-implement validation. This does the opposite: it lets the browser do
 * the checking (which is what it is good at, and what stays correct as input types grow) and
 * cancels only the REPORTING. Cancelling the `invalid` event suppresses the native bubble —
 * that is exactly what `preventDefault()` on it is specified to do — while the browser still
 * refuses to submit the form. Three things fall out of that and all of them matter:
 *   • a form written with `novalidate` in its markup is saying "I validate myself" and never
 *     fires `invalid` at all, so checkout is opted out with no flag to remember;
 *   • forms rendered after page load are covered, because the listener is on `document` and
 *     there is nothing to attach per form;
 *   • if this module fails to load, the browser's own bubble is still there. The failure mode
 *     is an ugly message, never an unvalidated form.
 *
 * The DOM half lives here rather than in the boot script because it is testable: give jsdom a
 * field and a ValidityState and the message and the markup are both assertable.
 */

/** Every element that participates in constraint validation and can hold a message. */
export type ValidatableField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface FieldErrorStrings {
  required: string;
  email: string;
  url: string;
  number: string;
  /** Carries `{n}` — the bound. */
  tooShort: string;
  tooLong: string;
  min: string;
  max: string;
  pattern: string;
  invalid: string;
}

const FALLBACK: FieldErrorStrings = {
  required: 'יש למלא שדה זה',
  email: 'כתובת אימייל לא תקינה',
  url: 'כתובת אתר לא תקינה',
  number: 'יש להזין מספר',
  tooShort: 'לפחות {n} תווים',
  tooLong: 'עד {n} תווים',
  min: 'לא פחות מ-{n}',
  max: 'לא יותר מ-{n}',
  pattern: 'הערך אינו בפורמט הנדרש',
  invalid: 'הערך אינו תקין',
};

export const FIELD_ERROR_CLASS = 'field-error';

const fill = (template: string, n: string | number): string => template.replace('{n}', String(n));

export function isValidatableField(el: EventTarget | null): el is ValidatableField {
  return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}

/**
 * The message for whatever is currently wrong with `el`.
 *
 * A field may override any of it with `data-error` (one message for every failure it can have —
 * the right shape when a field has a bespoke `pattern` whose rule is only expressible in words).
 * `setCustomValidity()` still wins over that: a page that computed a specific reason knows more
 * than a static attribute does.
 *
 * The order is the order the user should hear about it: empty first (nothing else is meaningful
 * about an empty field), then the type, then the bounds.
 */
export function fieldErrorMessage(el: ValidatableField, strings: Partial<FieldErrorStrings> = {}): string {
  const s: FieldErrorStrings = { ...FALLBACK, ...strings };
  const v = el.validity;
  if (v.customError) return el.validationMessage;
  if (v.valueMissing) return s.required;

  const override = el.dataset.error;
  if (v.typeMismatch) {
    const type = el instanceof HTMLInputElement ? el.type : '';
    if (type === 'email') return s.email;
    if (type === 'url') return s.url;
    return override ?? s.invalid;
  }
  if (v.badInput || v.stepMismatch) return override ?? s.number;
  if (v.tooShort) return fill(s.tooShort, el instanceof HTMLSelectElement ? 0 : el.minLength);
  if (v.tooLong) return fill(s.tooLong, el instanceof HTMLSelectElement ? 0 : el.maxLength);
  if (v.rangeUnderflow && el instanceof HTMLInputElement) return fill(s.min, el.min);
  if (v.rangeOverflow && el instanceof HTMLInputElement) return fill(s.max, el.max);
  if (v.patternMismatch) return override ?? s.pattern;
  return override ?? s.invalid;
}

/** `aria-describedby` is a LIST and the field may already point at a hint. Add/remove our id
 *  without disturbing whatever else is in there — dropping the list wholesale is how a helpful
 *  hint silently stops being announced. */
function linkDescription(el: ValidatableField, id: string, on: boolean): void {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x && x !== id);
  if (on) ids.push(id);
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

let seq = 0;

/** The message element belonging to `el`, created on first need. Placed directly AFTER the field —
 *  which puts it inside the `<label class="field">` wrapper the auth forms use and directly under
 *  the control everywhere else, with no per-form layout knowledge. */
function errorSlot(el: ValidatableField): HTMLElement {
  const existing = el.nextElementSibling;
  if (existing instanceof HTMLElement && existing.classList.contains(FIELD_ERROR_CLASS)) return existing;
  const p = document.createElement('p');
  p.className = FIELD_ERROR_CLASS;
  p.id = `${el.id || el.name || 'field'}-err-${++seq}`;
  // `alert` and not `status`: this is the response to something the user just did, and it has to
  // interrupt — the same call `#form-global-error` on checkout already makes.
  p.setAttribute('role', 'alert');
  el.insertAdjacentElement('afterend', p);
  return p;
}

/** Mark the field wrong and say why. Idempotent — re-validating an already-marked field just
 *  updates the text, so nothing re-animates while the user is still typing in it. */
export function showFieldError(el: ValidatableField, message: string): void {
  const slot = errorSlot(el);
  if (slot.textContent !== message) slot.textContent = message;
  el.setAttribute('aria-invalid', 'true');
  linkDescription(el, slot.id, true);
}

/** Clear the mark. Safe to call on a field that never had one. */
export function clearFieldError(el: ValidatableField): void {
  el.removeAttribute('aria-invalid');
  const slot = el.nextElementSibling;
  if (slot instanceof HTMLElement && slot.classList.contains(FIELD_ERROR_CLASS)) {
    linkDescription(el, slot.id, false);
    slot.remove();
  }
}
