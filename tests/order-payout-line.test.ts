/**
 * The sentence a seller reads beside an order, and the split they read on the payments tab.
 *
 * Both are projections of `payout-hold.ts`, and both are now the ONLY place those facts appear —
 * the per-order table that used to carry them is gone (owner, סשן א׳ §4). So the risks worth
 * pinning are:
 *
 *   1. **A reason with no message.** `orderHold` can return `basis: null` for an order it cannot
 *      date. A lookup that returned `undefined` there would render an empty cell on a money screen,
 *      which reads as a value that failed to load rather than as an anomaly.
 *   2. **The wrong row highlighted.** Exactly one basis means the seller is blocking their own
 *      money. Colour it on the wrong one and the signal is worth nothing.
 *   3. **A split that does not add up.** The grouped rows are seller-visible money figures and the
 *      tile above them is their total; the invariant is asserted in
 *      `reporting-invariants.test.ts`, and this file pins the grouping's own edges (empty groups
 *      dropped, unattributable slices reported rather than swallowed).
 */
import { describe, it, expect } from 'vitest';
import { orderPayoutLine, payoutWhyText, splitHeldByBasis, storesWithHeldMoney, HELD_BASES, type HeldSlice } from '../src/lib/order-payout-line.js';
import { HOLD_DAYS_AFTER_DELIVERY, FALLBACK_DAYS_AFTER_PAYMENT } from '../src/lib/payout-schedule.js';
import { addDaysISO } from '../src/lib/date-range.js';

const TODAY = '2026-08-10';
const at = (dayISO: string) => `${dayISO}T12:00:00.000Z`;
const daysAgo = (n: number) => addDaysISO(TODAY, -n);

describe('the payout line an order card shows', () => {
  it('names the delivery clock, with no action, once the parcel has arrived', () => {
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'delivered',
      paidAt: at(daysAgo(20)),
      deliveredAt: at(daysAgo(1)),
    }, TODAY);
    expect(line.state).toBe('held');
    expect(line.basis).toBe('delivery');
    expect(line.whyKey).toBe('payWhyDelivery');
    expect(line.whyDays).toBe(HOLD_DAYS_AFTER_DELIVERY);
    expect(line.actionKey).toBe('payActionNone');
    expect(line.blocking).toBe(false);
    expect(line.releaseDayISO).not.toBeNull();
  });

  it('falls back to the payment clock, and asks for the delivery mark, when nobody has marked it', () => {
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'shipped',
      paidAt: at(daysAgo(2)),
      deliveredAt: null,
    }, TODAY);
    expect(line.basis).toBe('payment');
    expect(line.whyKey).toBe('payWhyPayment');
    expect(line.whyDays).toBe(FALLBACK_DAYS_AFTER_PAYMENT);
    expect(line.actionKey).toBe('payActionMarkDelivered');
    // Not blocking: the money is on a clock the seller cannot stop. Marking it delivered moves the
    // date, it does not decide whether they are paid.
    expect(line.blocking).toBe(false);
  });

  it('is the ONLY basis that blocks, and carries no date, while the parcel has not left', () => {
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'pending',
      paidAt: at(daysAgo(9)),
      deliveredAt: null,
    }, TODAY);
    expect(line.basis).toBe('unshipped');
    expect(line.releaseDayISO).toBeNull();
    expect(line.actionKey).toBe('payActionShip');
    expect(line.blocking).toBe(true);
  });

  it('says nothing is coming for an order that stopped counting, and offers no action', () => {
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'cancelled',
      paidAt: at(daysAgo(40)),
      deliveredAt: at(daysAgo(30)),
    }, TODAY);
    expect(line.state).toBe('not_payable');
    expect(line.releaseDayISO).toBeNull();
    expect(line.actionKey).toBe('payActionNone');
    expect(line.blocking).toBe(false);
  });

  it('never leaves the reason blank — an undateable order gets the anomaly message, not an empty cell', () => {
    // `paidAt` missing on a paid order is the shape `orderHold` cannot date.
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'delivered',
      paidAt: null,
      deliveredAt: null,
    }, TODAY);
    expect(line.whyKey).toBe('payWhyUnknown');
    expect(line.actionKey).toBe('payActionNone');
  });

  it('fills {n} only where the sentence has one', () => {
    const withN = orderPayoutLine({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(20)), deliveredAt: at(daysAgo(1)) }, TODAY);
    expect(payoutWhyText(withN, 'window of {n} days')).toBe(`window of ${HOLD_DAYS_AFTER_DELIVERY} days`);
    const withoutN = orderPayoutLine({ paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(9)), deliveredAt: null }, TODAY);
    expect(payoutWhyText(withoutN, 'not shipped yet')).toBe('not shipped yet');
  });
});

describe('the held split on the payments tab', () => {
  const slice = (basis: HeldSlice['hold']['basis'], agorot: number, state = 'held', storeSlug = 'shop'): HeldSlice => ({
    hold: { state, basis },
    netOfCommissionAgorot: agorot,
    storeSlug,
  });

  it('groups by reason, in the order the screen shows them', () => {
    const split = splitHeldByBasis([
      slice('unshipped', 500),
      slice('delivery', 100),
      slice('payment', 200),
      slice('delivery', 300),
    ]);
    expect(split.groups.map((g) => g.basis)).toEqual([...HELD_BASES]);
    expect(split.groups.find((g) => g.basis === 'delivery')).toMatchObject({ orders: 2, agorot: 400 });
    expect(split.groups.find((g) => g.basis === 'unshipped')).toMatchObject({ orders: 1, agorot: 500 });
  });

  it('drops empty groups rather than printing a permanent zero row', () => {
    const split = splitHeldByBasis([slice('delivery', 100)]);
    expect(split.groups.map((g) => g.basis)).toEqual(['delivery']);
  });

  it('counts only what is on HOLD — a released slice is already inside the payable tile', () => {
    const split = splitHeldByBasis([
      slice('delivery', 100),
      slice('delivery', 999, 'releasable'),
      slice(null, 777, 'not_payable'),
    ]);
    expect(split.groups).toHaveLength(1);
    expect(split.groups[0]!.agorot).toBe(100);
    expect(split.unknownOrders).toBe(0);
  });

  it('reports an unattributable slice instead of swallowing it', () => {
    const split = splitHeldByBasis([slice('delivery', 100), slice(null, 250)]);
    expect(split.unknownOrders).toBe(1);
    expect(split.unknownAgorot).toBe(250);
  });

  /**
   * The per-store split (owner, 2026-08-11). The seller's Orders tab shows ONE shop, so a row that
   * pooled two of them could only link into one — it showed a subset and called it the answer. The
   * money above the table stays account-wide (a payout is one transfer across every shop), so the
   * property that has to hold is that the sections still add up to it.
   */
  it('narrows to one shop, and the shops still sum to the whole account', () => {
    const slices = [
      slice('unshipped', 500, 'held', 'shop-a'),
      slice('delivery', 100, 'held', 'shop-a'),
      slice('payment', 200, 'held', 'shop-b'),
      slice('delivery', 300, 'held', 'shop-b'),
    ];
    const a = splitHeldByBasis(slices, 'shop-a');
    expect(a.groups.map((g) => g.basis)).toEqual(['delivery', 'unshipped']);
    expect(a.groups.reduce((t, g) => t + g.agorot, 0)).toBe(600);

    const b = splitHeldByBasis(slices, 'shop-b');
    expect(b.groups.map((g) => g.basis)).toEqual(['delivery', 'payment']);
    expect(b.groups.reduce((t, g) => t + g.agorot, 0)).toBe(500);

    const whole = splitHeldByBasis(slices);
    const perStore = [a, b].reduce((t, s) => t + s.groups.reduce((x, g) => x + g.agorot, 0) + s.unknownAgorot, 0);
    expect(perStore, 'the sections must add up to the tile above them')
      .toBe(whole.groups.reduce((t, g) => t + g.agorot, 0) + whole.unknownAgorot);
  });

  it('lists the shops that actually have money waiting, and only those', () => {
    const slices = [
      slice('delivery', 100, 'held', 'shop-a'),
      slice('delivery', 999, 'releasable', 'shop-b'),
      slice('unshipped', 200, 'held', 'shop-c'),
      slice('payment', 50, 'held', 'shop-a'),
    ];
    // shop-b's money is released, not held — it belongs to the payable tile, not to this table.
    expect(storesWithHeldMoney(slices)).toEqual(['shop-a', 'shop-c']);
  });

  it('adds up: every held slice lands in exactly one line', () => {
    const slices = [
      slice('delivery', 100), slice('payment', 200), slice('unshipped', 300),
      slice(null, 400), slice('delivery', 500), slice('delivery', 600, 'releasable'),
    ];
    const split = splitHeldByBasis(slices);
    const heldTotal = slices.filter((s) => s.hold.state === 'held').reduce((t, s) => t + s.netOfCommissionAgorot, 0);
    const shown = split.groups.reduce((t, g) => t + g.agorot, 0) + split.unknownAgorot;
    expect(shown).toBe(heldTotal);
    const shownOrders = split.groups.reduce((t, g) => t + g.orders, 0) + split.unknownOrders;
    expect(shownOrders).toBe(slices.filter((s) => s.hold.state === 'held').length);
  });
});
