// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { initFormValidity } from '../src/scripts/form-validity.js';
import { FIELD_ERROR_CLASS } from '../src/lib/field-validity.js';

/**
 * The validation message has to go away when the form puts the value back.
 *
 * **Why this test exists, and it is the honest reason.** `tests/field-validity.test.ts` already
 * covered this module's own functions — which message a ValidityState maps to, where the element
 * is inserted, that `aria-describedby` survives. All of it passed while the actual behaviour was
 * broken: the seller emptied a required field, saved, saw the message, pressed "בטל שינויים", the
 * value came back and the message stayed (owner, 2026-08-10). The unit tests were aimed at the
 * module's inside; the bug was at the seam where it meets the dashboard.
 *
 * That seam is a KNOWN class here — `field-repaint-guard.test.ts` holds it for widgets that WRITE
 * a field programmatically, because `discardChanges` and a recovered draft replace values without
 * firing `input` and announce it with `dash:fieldsrewritten` instead. This module is the reader
 * half of the same rule, and nobody had written that half down.
 *
 * So this drives the real listeners rather than calling exported helpers: mark a field the way a
 * failed submit does, then replace its value the way the dashboard does, and assert what the
 * seller sees.
 */
function mount(): { form: HTMLFormElement; field: HTMLInputElement } {
  document.body.innerHTML = `
    <form id="settings">
      <label>שם החנות <input id="storeName" name="storeName" required value="חנות" /></label>
      <button type="submit">שמור</button>
    </form>`;
  return {
    form: document.getElementById('settings') as HTMLFormElement,
    field: document.getElementById('storeName') as HTMLInputElement,
  };
}

/** What a failed submit does: the browser fires `invalid` on each bad control. */
function submitWithEmptyField(field: HTMLInputElement): void {
  field.value = '';
  field.dispatchEvent(new Event('invalid', { bubbles: false, cancelable: true }));
}

const messageEl = (): HTMLElement | null => document.querySelector(`.${FIELD_ERROR_CLASS}`);

beforeEach(() => {
  document.body.innerHTML = '';
  // The listeners sit on `document` and are idempotent enough to re-arm per test; jsdom gives each
  // file a fresh document, so this is one registration per run in practice.
  initFormValidity();
});

describe('a restored value clears the message it caused', () => {
  it('marks the field when a submit finds it empty', () => {
    const { field } = mount();
    submitWithEmptyField(field);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(messageEl()?.textContent).toBeTruthy();
  });

  it('clears it when "discard changes" writes the value back', () => {
    const { form, field } = mount();
    submitWithEmptyField(field);
    expect(messageEl()).not.toBeNull();

    // Exactly what unsaved-guard.ts#discardChanges does: assign, then announce. No `input` event —
    // a programmatic write never fires one, which is the whole trap.
    field.value = 'חנות';
    form.dispatchEvent(new CustomEvent('dash:fieldsrewritten', { bubbles: true }));

    expect(messageEl(), 'the message outlived the value that caused it').toBeNull();
    expect(field.hasAttribute('aria-invalid')).toBe(false);
  });

  it('clears it on a native form reset too, which restores values just as silently', async () => {
    const { form, field } = mount();
    submitWithEmptyField(field);
    form.reset(); // restores the `value` attribute — "חנות"
    // `reset` fires BEFORE the values are restored, so the check is deferred a microtask.
    await Promise.resolve();
    expect(messageEl()).toBeNull();
  });

  it('keeps the message when the rewrite left the field still empty', () => {
    // The other half: a repaint is not an excuse to clear a mark that is still true. The seller
    // discarding back to a value that was ALREADY invalid must still see why they cannot save.
    const { form, field } = mount();
    submitWithEmptyField(field);
    field.value = '';
    form.dispatchEvent(new CustomEvent('dash:fieldsrewritten', { bubbles: true }));
    expect(messageEl()).not.toBeNull();
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('still clears on ordinary typing, which is the path that always worked', () => {
    const { field } = mount();
    submitWithEmptyField(field);
    field.value = 'חנות';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(messageEl()).toBeNull();
  });
});
