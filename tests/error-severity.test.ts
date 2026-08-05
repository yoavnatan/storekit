/**
 * The rule that decides whether a log entry is worth interrupting someone for.
 *
 * It is one pure function on purpose, and this is the file that keeps it honest. The cost of
 * getting it wrong is asymmetric and both directions are bad: a money failure classified as
 * ordinary is a charge nobody chased, and an ordinary failure classified as critical is an alert
 * channel that gets muted — after which the real one is not delivered either.
 */
import { describe, it, expect } from 'vitest';
import { deriveSeverity, isMoneyPath, SEVERITY_ORDER } from '../src/lib/error-severity.js';

describe('deriveSeverity', () => {
  it('calls a failure on the money path critical', () => {
    expect(deriveSeverity({ source: 'server', route: '/api/checkout', statusCode: 500 })).toBe('critical');
    expect(deriveSeverity({ source: 'server', route: '/checkout', statusCode: 500 })).toBe('critical');
    // Order status changes drive restock on cancellation and the buyer's "shipped" mail. A failure
    // leaves stock and the buyer's expectations out of step — the same class of harm as a bad charge,
    // however much the route looks like ordinary dashboard CRUD.
    expect(deriveSeverity({ source: 'server', route: '/api/seller/orders', statusCode: 500 })).toBe('critical');
  });

  it('covers the payment webhook that does not exist yet', () => {
    // GO_LIVE §3. Listed ahead of the file so the most money-critical route in the system is not
    // born at the wrong severity and left there until somebody notices.
    expect(deriveSeverity({ source: 'server', route: '/api/payment/confirm', statusCode: 500 })).toBe('critical');
  });

  it('calls any other server failure an error', () => {
    expect(deriveSeverity({ source: 'server', route: '/search', statusCode: 500 })).toBe('error');
    expect(deriveSeverity({ source: 'server', route: '/api/notifications', statusCode: 500 })).toBe('error');
    // No route at all — still a server failure, and 'error' is the honest label for unclassified.
    expect(deriveSeverity({ source: 'server' })).toBe('error');
  });

  it('calls every browser report a warning, including on the money path', () => {
    // Deliberate, and the most likely thing to be argued with later. A JS error that breaks
    // "add to cart" for everyone matters enormously — and ONE report cannot be told apart from an
    // ad-blocker or a three-version-old browser. Volume is what distinguishes a real outage, and
    // volume is not a property of a single entry. So the browser reports quietly and the server pages.
    expect(deriveSeverity({ source: 'client', route: '/checkout' })).toBe('warning');
    expect(deriveSeverity({ source: 'client', route: '/api/checkout' })).toBe('warning');
  });
});

describe('isMoneyPath', () => {
  it('matches the prefix and its children, not a lookalike', () => {
    expect(isMoneyPath('/api/checkout')).toBe(true);
    expect(isMoneyPath('/api/checkout/retry')).toBe(true);
    // The trap a bare `startsWith` would fall into: a different route that merely begins with the
    // same letters must not inherit the loudest level in the system.
    expect(isMoneyPath('/api/checkout-preview')).toBe(false);
    expect(isMoneyPath('/api/checkoutish')).toBe(false);
  });

  it('ignores the query string, which the caller controls', () => {
    // A request cannot be allowed to raise or lower how loudly its own failure is reported.
    expect(isMoneyPath('/search?q=/api/checkout')).toBe(false);
    expect(isMoneyPath('/api/checkout?step=2')).toBe(true);
  });

  it('is false for nothing at all', () => {
    expect(isMoneyPath(undefined)).toBe(false);
    expect(isMoneyPath(null)).toBe(false);
    expect(isMoneyPath('')).toBe(false);
  });

  it('leaves the price recalculation out', () => {
    // It blocks the buyer BEFORE anything is charged, loudly and visibly, and leaves nothing
    // inconsistent behind it — bad, but not the level that wakes someone.
    expect(isMoneyPath('/api/cart/prices')).toBe(false);
  });
});

describe('SEVERITY_ORDER', () => {
  it('runs loudest first, which is what the UI renders by', () => {
    expect(SEVERITY_ORDER).toEqual(['critical', 'error', 'warning']);
  });
});
