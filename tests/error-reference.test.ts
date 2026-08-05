/**
 * The code that links a mail to a row, and the sentence that says what the row means.
 *
 * Both exist for a workflow rather than a schema: the alert arrives on a phone, the dashboard is on
 * a laptop, and the fix happens later in a conversation with somebody who was not there. All three
 * have to name the same failure the same way.
 */
import { describe, it, expect } from 'vitest';
import { errorRef, errorMeaning } from '../src/lib/error-reference.js';

describe('errorRef', () => {
  it('is short enough to carry from a phone screen to a laptop screen', () => {
    expect(errorRef('4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a')).toBe('#4f8c2a1e');
    expect(errorRef('4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a')).toHaveLength(9);
  });

  it('is stable — the same entry always produces the same code', () => {
    // It is printed in a mail and then looked for on a screen; a code that differed between the two
    // renders would be worse than no code, because it would look like a match that is not one.
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(errorRef(id)).toBe(errorRef(id));
    expect(errorRef(id)).toBe('#aaaaaaaa');
  });

  it('distinguishes ids that differ inside the first block', () => {
    expect(errorRef('11111111-0000-0000-0000-000000000000'))
      .not.toBe(errorRef('22222222-0000-0000-0000-000000000000'));
  });
});

describe('errorMeaning', () => {
  it('says what happened to a person, not what happened to a route', () => {
    // The row already carries /api/checkout and 500. Between them they say everything except the
    // only thing that decides what happens next.
    expect(errorMeaning('/api/checkout', 'critical')).toBe('קונה לא הצליח להשלים רכישה');
    expect(errorMeaning('/api/payment/confirm', 'critical')).toContain('אישור התשלום');
    expect(errorMeaning('/api/seller/orders', 'critical')).toContain('סטטוס הזמנה');
  });

  it('matches a prefix and its children, not a lookalike route', () => {
    expect(errorMeaning('/api/checkout/retry', 'critical')).toBe('קונה לא הצליח להשלים רכישה');
    expect(errorMeaning('/api/checkout-preview', 'error')).not.toBe('קונה לא הצליח להשלים רכישה');
  });

  it('ignores the query string, which the caller controls', () => {
    // A request must not be able to choose the sentence a person reads about what happened — the
    // same rule isMoneyPath follows.
    expect(errorMeaning('/search?q=/api/checkout', 'error')).not.toBe('קונה לא הצליח להשלים רכישה');
    expect(errorMeaning('/api/checkout?step=2', 'critical')).toBe('קונה לא הצליח להשלים רכישה');
  });

  it('always says something, because a blank would read as "we do not know what this is"', () => {
    expect(errorMeaning('/some/unmapped/route', 'error')).toBeTruthy();
    expect(errorMeaning(undefined, 'warning')).toBeTruthy();
    expect(errorMeaning(null, undefined)).toBeTruthy();
  });

  it('falls back by severity when the route is not one it knows', () => {
    expect(errorMeaning('/some/unmapped/route', 'warning')).toContain('דפדפן');
    expect(errorMeaning('/some/unmapped/route', 'error')).toContain('שרת');
  });

  it('does not claim a critical entry on an unknown route is ordinary', () => {
    // If this ever fires it means error-severity.ts knows a money path this file does not — a drift
    // between two lists that must not quietly read as "nothing special".
    expect(errorMeaning('/some/unmapped/route', 'critical')).toContain('כסף');
  });
});
