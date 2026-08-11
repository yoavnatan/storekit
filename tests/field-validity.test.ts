// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  fieldErrorMessage,
  showFieldError,
  clearFieldError,
  isValidatableField,
  FIELD_ERROR_CLASS,
  type FieldErrorStrings,
  type ValidatableField,
} from '../src/lib/field-validity.js';

const STRINGS: Partial<FieldErrorStrings> = {
  required: 'REQUIRED',
  email: 'EMAIL',
  url: 'URL',
  number: 'NUMBER',
  tooShort: 'SHORT {n}',
  tooLong: 'LONG {n}',
  min: 'MIN {n}',
  max: 'MAX {n}',
  pattern: 'PATTERN',
  invalid: 'INVALID',
};

const ALL_VALID = {
  valueMissing: false, typeMismatch: false, patternMismatch: false, tooLong: false,
  tooShort: false, rangeUnderflow: false, rangeOverflow: false, stepMismatch: false,
  badInput: false, customError: false, valid: false,
};

/** jsdom implements `valueMissing` but not the length/range flags (they need the dirty-value
 *  flag it does not track), so the state is stubbed rather than provoked. The mapping from a
 *  ValidityState to a sentence is the thing under test — producing the state is the browser's job. */
function fieldWith(state: Partial<typeof ALL_VALID>, tag: 'input' | 'textarea' = 'input'): ValidatableField {
  const el = document.createElement(tag);
  Object.defineProperty(el, 'validity', { value: { ...ALL_VALID, ...state }, configurable: true });
  return el;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('fieldErrorMessage', () => {
  it('reports an empty field before anything else about it', () => {
    // A required email left blank is BOTH missing and (on some engines) a type mismatch. "Fill
    // this in" is the only one of those that helps.
    const el = fieldWith({ valueMissing: true, typeMismatch: true });
    expect(fieldErrorMessage(el, STRINGS)).toBe('REQUIRED');
  });

  it('names the type that failed, by the input type', () => {
    const email = fieldWith({ typeMismatch: true }) as HTMLInputElement;
    email.type = 'email';
    expect(fieldErrorMessage(email, STRINGS)).toBe('EMAIL');

    const url = fieldWith({ typeMismatch: true }) as HTMLInputElement;
    url.type = 'url';
    expect(fieldErrorMessage(url, STRINGS)).toBe('URL');
  });

  it('substitutes the actual bound into the length and range messages', () => {
    const short = fieldWith({ tooShort: true }) as HTMLInputElement;
    short.minLength = 6;
    expect(fieldErrorMessage(short, STRINGS)).toBe('SHORT 6');

    const long = fieldWith({ tooLong: true }) as HTMLInputElement;
    long.maxLength = 120;
    expect(fieldErrorMessage(long, STRINGS)).toBe('LONG 120');

    const under = fieldWith({ rangeUnderflow: true }) as HTMLInputElement;
    under.min = '1';
    expect(fieldErrorMessage(under, STRINGS)).toBe('MIN 1');

    const over = fieldWith({ rangeOverflow: true }) as HTMLInputElement;
    over.max = '500';
    expect(fieldErrorMessage(over, STRINGS)).toBe('MAX 500');
  });

  it('lets a field override the generic messages with data-error, but never the required one', () => {
    const pattern = fieldWith({ patternMismatch: true });
    pattern.dataset.error = 'ONLY LETTERS';
    expect(fieldErrorMessage(pattern, STRINGS)).toBe('ONLY LETTERS');

    const missing = fieldWith({ valueMissing: true });
    missing.dataset.error = 'ONLY LETTERS';
    expect(fieldErrorMessage(missing, STRINGS)).toBe('REQUIRED');
  });

  it('prefers a reason the page computed with setCustomValidity', () => {
    const el = fieldWith({ customError: true, valueMissing: true }) as HTMLInputElement;
    Object.defineProperty(el, 'validationMessage', { value: 'That code is already taken' });
    expect(fieldErrorMessage(el, STRINGS)).toBe('That code is already taken');
  });

  it('falls back to Hebrew when the i18n island did not travel', () => {
    // The failure mode this guards is an English literal appearing inside a Hebrew UI — the same
    // class tests/i18n-island-scope.test.ts exists for.
    expect(fieldErrorMessage(fieldWith({ valueMissing: true }))).toBe('יש למלא שדה זה');
  });
});

describe('showFieldError / clearFieldError', () => {
  function mount(): ValidatableField {
    document.body.innerHTML = '<label class="field"><span>Email</span><input id="e" name="email"><p id="hint">hint</p></label>';
    return document.getElementById('e') as HTMLInputElement;
  }

  it('puts the message directly after the field and marks the field invalid', () => {
    const el = mount();
    showFieldError(el, 'REQUIRED');
    const slot = el.nextElementSibling as HTMLElement;
    expect(slot.className).toBe(FIELD_ERROR_CLASS);
    expect(slot.textContent).toBe('REQUIRED');
    expect(slot.getAttribute('role')).toBe('alert');
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(el.getAttribute('aria-describedby')).toBe(slot.id);
  });

  it('does not stack a second message when the same field fails again', () => {
    const el = mount();
    showFieldError(el, 'REQUIRED');
    showFieldError(el, 'EMAIL');
    expect(document.querySelectorAll(`.${FIELD_ERROR_CLASS}`)).toHaveLength(1);
    expect((el.nextElementSibling as HTMLElement).textContent).toBe('EMAIL');
    expect(el.getAttribute('aria-describedby')).toBe((el.nextElementSibling as HTMLElement).id);
  });

  it('keeps a hint the field was already described by, and puts it back on clear', () => {
    const el = mount();
    el.setAttribute('aria-describedby', 'hint');
    showFieldError(el, 'REQUIRED');
    const ids = (el.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toContain('hint');
    expect(ids).toHaveLength(2);

    clearFieldError(el);
    expect(el.getAttribute('aria-describedby')).toBe('hint');
    expect(el.hasAttribute('aria-invalid')).toBe(false);
    expect(document.querySelectorAll(`.${FIELD_ERROR_CLASS}`)).toHaveLength(0);
  });

  it('is safe on a field that was never marked', () => {
    const el = mount();
    expect(() => clearFieldError(el)).not.toThrow();
    expect(document.getElementById('hint')).not.toBeNull();
  });
});

describe('isValidatableField', () => {
  it('accepts the three form controls and nothing else', () => {
    expect(isValidatableField(document.createElement('input'))).toBe(true);
    expect(isValidatableField(document.createElement('select'))).toBe(true);
    expect(isValidatableField(document.createElement('textarea'))).toBe(true);
    expect(isValidatableField(document.createElement('button'))).toBe(false);
    expect(isValidatableField(null)).toBe(false);
  });
});
