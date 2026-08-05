/**
 * The code that links a mail to a row, and the sentence that says what the row means.
 *
 * Both exist for a workflow rather than a schema: the alert arrives on a phone, the dashboard is on
 * a laptop, and the fix happens later in a conversation with somebody who was not there. All three
 * have to name the same failure the same way.
 */
import { describe, it, expect } from 'vitest';
import { errorRef, errorMeaning, errorCopyText } from '../src/lib/error-reference.js';

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

/**
 * One description of a failure for every place a person is handed one.
 *
 * There were two builders and they had already drifted: the dashboard's copy button produced source
 * and actor role, the alert mail produced the reference code and the meaning, and neither had the
 * other's fields. Two blocks describing the same failure differently is worse than either alone —
 * the mail on the phone, the row on the screen and the text pasted into a conversation have to be
 * recognisably the same event.
 */
describe('errorCopyText', () => {
  const full = {
    id: '4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a',
    severity: 'critical' as const,
    route: '/api/checkout',
    message: 'Payment gateway refused',
    stack: 'Error: Payment gateway refused\n    at chargeCard (payment.ts:42)',
    source: 'server',
    storeName: 'חנות הדוגמה',
    actorLabel: 'buyer@example.com',
    actorRole: 'buyer',
    statusCode: 500,
    resolutionHint: 'המלאי שוחזר אוטומטית. בעגלה: כיסא ×2.',
  };

  it('leads with the sentence a person can read, not with a stack', () => {
    const text = errorCopyText(full, { when: '5.8.2026, 22:22' });
    expect(text.split('\n')[0]).toBe('קונה לא הצליח להשלים רכישה #4f8c2a1e');
  });

  it('carries everything needed to act without opening anything else', () => {
    const text = errorCopyText(full, { when: '5.8.2026, 22:22' });
    for (const expected of [
      '#4f8c2a1e', '/api/checkout', '500', 'חנות הדוגמה', 'buyer@example.com',
      'Payment gateway refused', 'בעגלה: כיסא ×2', 'at chargeCard (payment.ts:42)',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('says when it cut the stack, and only cuts when asked to', () => {
    // The mail caps it because a phone is not a place to scroll a trace; the dashboard does not,
    // because on a screen scrolling is free. A cut the reader cannot see is the bug either way.
    const long = { ...full, stack: 'x'.repeat(3000) };
    expect(errorCopyText(long, { maxStack: 1200 })).toContain('נחתך');
    expect(errorCopyText(long)).not.toContain('נחתך');
  });

  it('renders every field as a dash rather than "undefined" when it is missing', () => {
    const text = errorCopyText({ severity: 'error' });
    expect(text).not.toContain('undefined');
    expect(text).toContain('stack: —');
  });
});
