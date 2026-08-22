/**
 * The fulfilment clock, and the two fairness rules it has to obey.
 *
 * 1. A seller is only ever late for something they CONTROL. Once the parcel is with a courier, a
 *    slow courier must never produce a warning aimed at the seller.
 * 2. The window may not be shorter than what the buyer is entitled to, and the money may not be
 *    released before the buyer's statutory right to cancel has run out.
 */
import { describe, it, expect } from 'vitest';
import { fulfilmentStatus, SHIP_DEADLINE_BUSINESS_DAYS, SHIP_WARNING_DAYS, SHIP_AUTO_CANCEL_DAYS } from '../src/lib/order-sla.js';
import { addDaysISO } from '../src/lib/date-range.js';

const TODAY = '2026-08-10';
const at = (dayISO: string) => `${dayISO}T12:00:00.000Z`;
const daysAgo = (n: number) => addDaysISO(TODAY, -n);

const paidUnshipped = (n: number, deliveryMethod: 'courier' | 'pickup' = 'courier') => ({
  paymentStatus: 'paid' as const,
  shippingStatus: 'pending' as const,
  paidAt: at(daysAgo(n)),
  deliveredAt: null,
  deliveryMethod,
});

describe('when the seller is late', () => {
  it('is fine before the warning day', () => {
    expect(fulfilmentStatus(paidUnshipped(SHIP_WARNING_DAYS - 1), TODAY).state).toBe('ok');
  });

  it('warns on the warning day itself', () => {
    // Inclusive, like the hold rule — a date shown to someone has to be the date it happens.
    expect(fulfilmentStatus(paidUnshipped(SHIP_WARNING_DAYS), TODAY).state).toBe('warn');
  });

  it('is overdue on the cancel day itself', () => {
    expect(fulfilmentStatus(paidUnshipped(SHIP_AUTO_CANCEL_DAYS), TODAY).state).toBe('overdue');
    expect(fulfilmentStatus(paidUnshipped(SHIP_AUTO_CANCEL_DAYS + 30), TODAY).state).toBe('overdue');
  });

  it('carries both dates so a seller can be told when, not just that', () => {
    const s = fulfilmentStatus(paidUnshipped(1), TODAY);
    expect(s.dueDayISO).toBe(addDaysISO(daysAgo(1), SHIP_WARNING_DAYS));
    expect(s.cancelDayISO).toBe(addDaysISO(daysAgo(1), SHIP_AUTO_CANCEL_DAYS));
  });
});

describe('a seller is never late for someone else', () => {
  it('stops the clock once a courier order is shipped', () => {
    // The parcel is with the courier. A slow courier is our problem and the buyer's, never a
    // warning aimed at the seller.
    expect(fulfilmentStatus({ ...paidUnshipped(90), shippingStatus: 'shipped' }, TODAY).state).toBe('ok');
  });

  it('stops the clock for self-pickup at READY, not at shipped', () => {
    // A collected order never reaches `shipped`. Its seller's last controllable act is packing it,
    // so warning them because the buyer has not turned up would be punishing them for the buyer.
    expect(fulfilmentStatus({ ...paidUnshipped(90, 'pickup'), shippingStatus: 'ready' }, TODAY).state).toBe('ok');
  });

  it('but READY does NOT stop the clock for a courier order', () => {
    // The pair that proves the delivery method is doing the work. A packed parcel that was never
    // handed over is still the seller's to hand over.
    expect(fulfilmentStatus({ ...paidUnshipped(90, 'courier'), shippingStatus: 'ready' }, TODAY).state).toBe('overdue');
  });
});

describe('orders the question does not apply to', () => {
  it('says nothing about an unpaid order — nobody is owed anything', () => {
    expect(fulfilmentStatus({ ...paidUnshipped(90), paymentStatus: 'pending' }, TODAY).state).toBe('ok');
  });

  it('says nothing about an already-cancelled one', () => {
    expect(fulfilmentStatus({ ...paidUnshipped(90), shippingStatus: 'cancelled' }, TODAY).state).toBe('ok');
  });

  it('invents no clock for an order it cannot date', () => {
    expect(fulfilmentStatus({ ...paidUnshipped(90), paidAt: null }, TODAY).state).toBe('ok');
  });
});

describe('the periods are internally coherent', () => {
  // Two of the four cases here compared the fulfilment deadlines against the PAYOUT hold — the
  // seller's money had to be unreleasable while an order was still on the cancellation path, and the
  // hold had to outlast the buyer's statutory right to cancel. Neither can be asserted any more and
  // neither needs to be: the platform releases nothing, so there is no release to race.
  it('warns before it cancels', () => {
    expect(SHIP_WARNING_DAYS).toBeLessThan(SHIP_AUTO_CANCEL_DAYS);
  });

  it('gives the seller a working-day deadline shorter than the day it cancels on', () => {
    expect(SHIP_DEADLINE_BUSINESS_DAYS).toBeLessThan(SHIP_AUTO_CANCEL_DAYS);
  });
});
