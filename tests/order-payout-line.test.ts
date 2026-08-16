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
import { orderPayoutLine, payoutLineText, payoutWhyText, splitHeldByBasis, storesWithHeldMoney, payableHeadlineAgorot, HELD_BASES, type HeldSlice } from '../src/lib/order-payout-line.js';
import { HOLD_DAYS_AFTER_DELIVERY, FALLBACK_DAYS_AFTER_PAYMENT, PAYOUT_WEEKDAY, nextPayoutDayISO } from '../src/lib/payout-schedule.js';
import { addDaysISO } from '../src/lib/date-range.js';
import { translations } from '../src/i18n/translations.js';

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

  /**
   * ── The date the card prints is the day the TRANSFER goes out (owner, 2026-08-16) ──
   * It used to print the release day under the word "אחרי", and he asked what "אחרי" meant. Nothing
   * good: the hold can end on a Tuesday while the run that pays it leaves on the following Sunday,
   * so the date on the card was a day on which nothing happened to anyone's money. These pin that
   * the two dates are genuinely different and that the one shown is the payout run's.
   */
  it('names the payout RUN, not the day the hold ends', () => {
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'delivered',
      paidAt: at(daysAgo(20)),
      deliveredAt: at(daysAgo(1)),
    }, TODAY);
    expect(line.payoutDayISO).toBe(nextPayoutDayISO(line.releaseDayISO!));
    expect(new Date(`${line.payoutDayISO}T12:00:00Z`).getUTCDay()).toBe(PAYOUT_WEEKDAY);
    // Not a rename of the same field: the release day here is a Tuesday, five days before the run.
    expect(line.payoutDayISO).not.toBe(line.releaseDayISO);
    expect(line.payoutDayISO! > line.releaseDayISO!).toBe(true);
  });

  it('counts released money from TODAY — the run its own release day caught may already be gone', () => {
    // Delivered long ago: released weeks back, and the runs since then may have skipped it (below
    // the minimum, no bank details). The seller's question is which run is next, never which it
    // missed — a date in the past on a "when do I get paid" line is worse than no date at all.
    const line = orderPayoutLine({
      paymentStatus: 'paid',
      shippingStatus: 'delivered',
      paidAt: at(daysAgo(90)),
      deliveredAt: at(daysAgo(60)),
    }, TODAY);
    expect(line.state).toBe('releasable');
    expect(line.payoutDayISO).toBe(nextPayoutDayISO(TODAY));
    expect(line.payoutDayISO! >= TODAY).toBe(true);
  });

  it('has no payout day where no clock has started', () => {
    const unshipped = orderPayoutLine({ paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(9)), deliveredAt: null }, TODAY);
    expect(unshipped.payoutDayISO).toBeNull();
    const cancelled = orderPayoutLine({ paymentStatus: 'paid', shippingStatus: 'cancelled', paidAt: at(daysAgo(40)), deliveredAt: at(daysAgo(30)) }, TODAY);
    expect(cancelled.payoutDayISO).toBeNull();
  });

  it('fills {n} only where the sentence has one', () => {
    const withN = orderPayoutLine({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(20)), deliveredAt: at(daysAgo(1)) }, TODAY);
    expect(payoutWhyText(withN, 'window of {n} days')).toBe(`window of ${HOLD_DAYS_AFTER_DELIVERY} days`);
    const withoutN = orderPayoutLine({ paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(9)), deliveredAt: null }, TODAY);
    expect(payoutWhyText(withoutN, 'not shipped yet')).toBe('not shipped yet');
  });
});

/**
 * The two strings the card prints, which three renderers now take from one function rather than
 * each writing the same four-branch ternary (the admin's had already drifted from the other two).
 * The branch that has to hold is the undateable one: an order `payout-hold.ts` could not date is
 * `held`, so a renderer keyed on the state alone reaches for a null date and prints "צפוי ב" with
 * nothing after it, on a money screen.
 */
describe('the two halves of the sentence a card prints', () => {
  const textFor = (order: Parameters<typeof orderPayoutLine>[0]) => payoutLineText(orderPayoutLine(order, TODAY));

  it('answers with a date and a reason once a clock is running', () => {
    const delivered = textFor({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(20)), deliveredAt: at(daysAgo(1)) });
    expect(delivered.mainKey).toBe('orderPayoutExpected');
    expect(delivered.dateISO).not.toBeNull();
    expect(delivered.whyKey).toBe('payFilter_window');

    const shipped = textFor({ paymentStatus: 'paid', shippingStatus: 'shipped', paidAt: at(daysAgo(2)), deliveredAt: null });
    expect(shipped.whyKey).toBe('payFilter_undelivered');

    const released = textFor({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(90)), deliveredAt: at(daysAgo(60)) });
    expect(released.mainKey).toBe('orderPayoutExpected');
    expect(released.whyKey).toBe('payFilter_released');
  });

  it('says what produces a date when there is none to give', () => {
    const unshipped = textFor({ paymentStatus: 'paid', shippingStatus: 'pending', paidAt: at(daysAgo(9)), deliveredAt: null });
    expect(unshipped).toMatchObject({ mainKey: 'payFilter_unshipped', dateISO: null, whyKey: 'orderPayoutUnshippedHint' });
  });

  it('never reaches for a date it does not have — the undateable order says so instead', () => {
    // `paidAt` missing on a paid, delivered order: held, no basis, no release day. The old
    // state-only ternary printed the "ישולם אחרי {date}" branch here with an empty date.
    const anomaly = textFor({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: null, deliveredAt: null });
    expect(anomaly).toMatchObject({ mainKey: 'payWhyUnknown', dateISO: null, whyKey: null });
  });

  it('offers no reason beside an answer that already carries one', () => {
    const cancelled = textFor({ paymentStatus: 'paid', shippingStatus: 'cancelled', paidAt: at(daysAgo(40)), deliveredAt: at(daysAgo(30)) });
    expect(cancelled).toMatchObject({ mainKey: 'payFilter_none', whyKey: null });
  });

  /**
   * The keys are looked up dynamically (`tt(text.mainKey)`), so `orders-i18n.test.ts`'s literal
   * `tt('key')` scan cannot see them — a key missing from a dictionary would render as an empty
   * string on the money line rather than fail anything. Both dictionaries, both halves.
   */
  it('only names keys both languages define', () => {
    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    const keys = ['payFilter_none', 'payFilter_unshipped', 'payWhyUnknown', 'orderPayoutExpected',
      'orderPayoutUnshippedHint', 'payFilter_undelivered', 'payFilter_window', 'payFilter_released',
      'orderPayoutLabel', 'orderPayoutHow'];
    expect(keys.filter((k) => !he[k] || !en[k])).toEqual([]);
    // All five of the toolbar filter's options are among them, and that is the point rather than a
    // coincidence: the card renders the string the seller filtered by, so the two cannot drift into
    // separate vocabularies again ("טרם נמסר" on a card the filter called "בדרך ללקוח").
    expect(keys.filter((k) => k.startsWith('payFilter_'))).toHaveLength(5);
  });

  it('interpolates a date only into the string that has a slot for it', () => {
    const he = translations.he.dashboard as unknown as Record<string, string>;
    const withDate = textFor({ paymentStatus: 'paid', shippingStatus: 'delivered', paidAt: at(daysAgo(20)), deliveredAt: at(daysAgo(1)) });
    expect(he[withDate.mainKey]).toContain('{date}');
    for (const key of ['payFilter_none', 'payFilter_unshipped', 'payWhyUnknown']) {
      expect(he[key], `${key} has no date to fill`).not.toContain('{date}');
    }
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

  /**
   * The "תשלום קרוב" headline, which two surfaces now print — the Payments tab's tile and the
   * seller overview's money row. It deliberately returns two DIFFERENT quantities depending on
   * `multiStore`, which is exactly the kind of rule that gets copied to a second call site with the
   * condition subtly rewritten, so it is asserted here rather than trusted to two components.
   */
  it('the headline is this shop\'s released money — but the ACCOUNT figure for a single-store seller', () => {
    const slices = [
      slice('delivery', 100, 'releasable', 'shop-a'),
      slice('delivery', 900, 'releasable', 'shop-b'),
      slice('unshipped', 500, 'held', 'shop-a'),
    ];
    // Two shops: shop-a's own released money, and nothing of shop-b's. The held slice is not
    // released and must not be in it.
    expect(payableHeadlineAgorot(slices, 'shop-a', true, 12_345)).toBe(100);
    // One shop: the account figure, which is `releasable − paidOut + adjustments` and is NOT the
    // same as the sum of that shop's released slices — that is the whole reason the branch exists.
    expect(payableHeadlineAgorot(slices, 'shop-a', false, 12_345)).toBe(12_345);
    // No shop resolved (a seller with none): the account figure, never a silent all-stores sum
    // dressed up as one shop's.
    expect(payableHeadlineAgorot(slices, null, true, 12_345)).toBe(12_345);
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
