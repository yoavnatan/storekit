/**
 * Wires `lib/field-validity.ts` to the whole site, from `BaseLayout` — one listener on
 * `document`, no per-form setup, and nothing to remember when a new form is written.
 *
 * Read `lib/field-validity.ts`'s header first: it explains why this cancels the browser's
 * REPORT rather than turning validation off, and what that buys.
 *
 * The one thing that has to happen here and not there is FOCUS. Cancelling every `invalid`
 * event also cancels the browser's "focus the first bad field" step, which is the part a
 * keyboard user depends on — so it is done by hand, once per submit attempt, on the first
 * field in document order. `invalid` events fire synchronously in one loop over the form's
 * controls, so a microtask scheduled from the first of them runs after the last has been
 * seen; that is what makes "first" knowable without waiting a frame.
 */
import {
  fieldErrorMessage,
  clearFieldError,
  showFieldError,
  isValidatableField,
  type FieldErrorStrings,
  type ValidatableField,
} from '../lib/field-validity.js';
import { scrollRowBackIntoView } from './dashboard/scroll-utils.js';

/** Escape hatch on a FORM: keep the browser's native bubbles. Nothing uses it today; it exists
 *  so that a page which genuinely wants the native UI has a way to say so other than deleting
 *  this module. (A form that validates ITSELF says so with `novalidate`, and never gets here.) */
const NATIVE_ATTR = 'data-native-validity';

let strings: Partial<FieldErrorStrings> = {};
let batch: ValidatableField[] = [];

function readStrings(): Partial<FieldErrorStrings> {
  try {
    const json = document.getElementById('i18n-data')?.textContent ?? '{}';
    return (JSON.parse(json) as { formErrors?: Partial<FieldErrorStrings> }).formErrors ?? {};
  } catch {
    return {};
  }
}

/** The first bad field, ordered by the FORM rather than by the order the browser happened to
 *  report them in. `form.elements` is in tree order, which is the order the person reading the
 *  page meets the fields — the only ordering that makes "first" mean anything to them. */
function focusFirst(fields: ValidatableField[]): void {
  const head = fields[0];
  if (!head) return;
  const controls = Array.from(head.form?.elements ?? []);
  const first = fields.reduce((best, el) => (controls.indexOf(el) < controls.indexOf(best) ? el : best), head);
  // Focus without the browser's own jump, then move the page ourselves: the site header is
  // `position:fixed`, so anything that parks an element at viewport top parks it underneath
  // (scroll-utils.ts). `scrollRowBackIntoView` also does NOTHING when the field is already
  // fully visible, which is the common case and must not move the page.
  first.focus({ preventScroll: true });
  // A field with no layout box — a required input in a `hidden` dashboard panel is the real case —
  // measures as a zero rect at the document origin, and scrolling "to" that yanks the page to the
  // top for something nobody can see. There is nothing useful to scroll to, so don't.
  const rect = first.getBoundingClientRect();
  if (rect.width || rect.height) scrollRowBackIntoView(first);
}

function onInvalid(e: Event): void {
  const el = e.target;
  if (!isValidatableField(el)) return;
  if (el.form?.hasAttribute(NATIVE_ATTR)) return;
  e.preventDefault(); // suppress the native bubble; the browser still blocks the submit
  showFieldError(el, fieldErrorMessage(el, strings));
  if (batch.length === 0) {
    queueMicrotask(() => {
      focusFirst(batch);
      batch = [];
    });
  }
  batch.push(el);
}

/** Clear as the field becomes correct — not as soon as it is touched. A message that vanishes on
 *  the first keystroke leaves the user retyping against nothing; one that stays until the value is
 *  actually acceptable is the confirmation that they fixed it.
 *  `validity.valid` and never `checkValidity()`: the latter FIRES `invalid` again, which would
 *  redraw the message this handler exists to remove. */
function onEdit(e: Event): void {
  const el = e.target;
  if (!isValidatableField(el)) return;
  if (el.getAttribute('aria-invalid') !== 'true') return;
  if (el.validity.valid) clearFieldError(el);
  else showFieldError(el, fieldErrorMessage(el, strings));
}

/**
 * Re-check every field this form has already marked.
 *
 * **The case that needed it, and it is a class this project had already learned twice.** The seller
 * empties a required field, presses save, sees the message — then presses "בטל שינויים", the value
 * comes back, and the message stays (owner, 2026-08-10). `unsaved-guard.ts#discardChanges` writes
 * `field.value` directly and dispatches `dash:fieldsrewritten`; it fires no `input` event, because
 * a programmatic write never does. So the handler below, which only ever heard `input`/`change`,
 * never learned the field had been fixed.
 *
 * `tests/field-repaint-guard.test.ts` holds exactly this rule for widgets that WRITE a field. This
 * module is the other half nobody had named: a reader that paints state FROM a field's value, and
 * which therefore has to re-derive it whenever the form replaces its fields from outside. The
 * writers' version of the bug had four instances; this is the reader's first.
 *
 * `reset` is handled with it — a native form reset restores values the same silent way.
 */
function revalidateMarked(form: HTMLFormElement): void {
  for (const el of Array.from(form.elements)) {
    if (!isValidatableField(el)) continue;
    if (el.getAttribute('aria-invalid') !== 'true') continue;
    if (el.validity.valid) clearFieldError(el);
    else showFieldError(el, fieldErrorMessage(el, strings));
  }
}

export function initFormValidity(): void {
  strings = readStrings();
  // Capture on all three: `invalid` does not bubble at all, and capturing the edits keeps this
  // ahead of a page handler that might re-render the field out from under us.
  document.addEventListener('invalid', onInvalid, true);
  document.addEventListener('input', onEdit, true);
  document.addEventListener('change', onEdit, true);

  // The form replaced its own fields — "discard changes" or a recovered draft (unsaved-guard.ts).
  document.addEventListener('dash:fieldsrewritten', (e) => {
    if (e.target instanceof HTMLFormElement) revalidateMarked(e.target);
  });
  // A native reset restores values the same silent way, and fires BEFORE it does — so the check
  // has to wait for the values it is checking.
  document.addEventListener('reset', (e) => {
    const form = e.target;
    if (form instanceof HTMLFormElement) queueMicrotask(() => revalidateMarked(form));
  });
}
