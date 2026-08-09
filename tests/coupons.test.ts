/**
 * The pure half of coupon codes — the calculation, and everything that has to distrust a seller's
 * keyboard before it reaches storage.
 *
 * The reason this file matters more than its size suggests: `checkCoupon` runs in TWO places, the
 * buyer's browser (to show a number) and `/api/checkout` (to charge one). If it were ever wrong in
 * a way that depended on where it ran, the failure would be a page that displays one total and a
 * card that is billed another — the single outcome the discounts feature is written to prevent.
 * So what is pinned here is the arithmetic and the boundaries, not the plumbing.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeCouponCode, couponDiscountAgorot, checkCoupon, isCouponLive, publicCoupon,
  COUPON_CODE_MAX, type StoreCoupon,
} from '../src/lib/coupons.js';
import { parseCouponInput, MAX_COUPON_AMOUNT, MAX_COUPON_USES } from '../src/lib/coupon-input.js';

function coupon(extra: Partial<StoreCoupon> = {}): StoreCoupon {
  return {
    id: 'c1', storeId: 's1', code: 'SAVE10', kind: 'percent', value: 10,
    minSubtotalAgorot: 0, usedCount: 0, active: true, ...extra,
  };
}

describe('normalizeCouponCode', () => {
  it('folds every spelling a buyer might type into the stored one', () => {
    // The flyer says "Summer 10"; the buyer types it three ways; all three have to reach one row.
    expect(normalizeCouponCode('summer10')).toBe('SUMMER10');
    expect(normalizeCouponCode('  Summer 10 ')).toBe('SUMMER10');
    expect(normalizeCouponCode('summer-10')).toBe('SUMMER-10'); // a dash is part of the code
  });

  it('drops what cannot be stored, and answers empty rather than half a code', () => {
    // Hebrew is deliberately not kept — unlike a slug. A code is dictated and typed on whatever
    // layout is open, so a Hebrew-only code is one most buyers cannot enter at all; refusing it at
    // the input layer is what stops it going out on a flyer.
    expect(normalizeCouponCode('קיץ')).toBe('');
    expect(normalizeCouponCode('  ')).toBe('');
    expect(normalizeCouponCode(undefined)).toBe('');
    expect(normalizeCouponCode('a'.repeat(200))).toHaveLength(COUPON_CODE_MAX);
  });
});

describe('couponDiscountAgorot', () => {
  it('takes a percent off an integer subtotal and stays an integer', () => {
    // 12.5% of 199.99 ₪ — the case that produces a fractional agora if anyone divides in ILS.
    const applied = couponDiscountAgorot({ kind: 'percent', value: 12 }, 19_999);
    expect(applied).toBe(2400);
    expect(Number.isInteger(applied)).toBe(true);
  });

  it('takes a ₪ amount off, converted once at the boundary', () => {
    expect(couponDiscountAgorot({ kind: 'amount', value: 25.5 }, 10_000)).toBe(2550);
  });

  it('never gives away more than the goods it applies to', () => {
    // A ₪50 voucher on a ₪30 cart. The buyer still owes shipping, which is not the seller's to
    // discount — and `reconcile.ts` reports any stored discount ABOVE its own subtotal as a corrupt
    // row, so an unclamped figure here would file an ordinary voucher as data corruption.
    expect(couponDiscountAgorot({ kind: 'amount', value: 50 }, 3000)).toBe(3000);
  });

  it('is zero on nothing to discount, rather than negative', () => {
    expect(couponDiscountAgorot({ kind: 'percent', value: 10 }, 0)).toBe(0);
    expect(couponDiscountAgorot({ kind: 'amount', value: 10 }, -500)).toBe(0);
    expect(couponDiscountAgorot({ kind: 'percent', value: 0 }, 10_000)).toBe(0);
  });
});

describe('checkCoupon', () => {
  it('applies a live code', () => {
    expect(checkCoupon(coupon(), 10_000)).toEqual({ ok: true, appliedAgorot: 1000 });
  });

  it('refuses a switched-off code as merely unknown', () => {
    // Collapsed with "no such code" on purpose: three distinct answers would turn the lookup
    // endpoint into an oracle confirming that a guessed code exists.
    expect(checkCoupon(coupon({ active: false }), 10_000)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('honours the schedule, with the end date inclusive', () => {
    const now = new Date(2026, 7, 9); // 2026-08-09, local — the schedule is a calendar day
    expect(checkCoupon(coupon({ startsAt: '2026-08-10' }), 10_000, now).ok).toBe(false);
    expect(checkCoupon(coupon({ endsAt: '2026-08-08' }), 10_000, now).ok).toBe(false);
    // The last day RUNS. A code that dies at midnight of the day it advertises is the classic
    // off-by-one, and it is the seller who takes the support call for it.
    expect(checkCoupon(coupon({ endsAt: '2026-08-09' }), 10_000, now).ok).toBe(true);
    expect(checkCoupon(coupon({ startsAt: '2026-08-09' }), 10_000, now).ok).toBe(true);
  });

  it('names an exhausted cap separately — somebody else took the last one', () => {
    expect(checkCoupon(coupon({ maxUses: 5, usedCount: 5 }), 10_000)).toEqual({ ok: false, reason: 'exhausted' });
    expect(checkCoupon(coupon({ maxUses: 5, usedCount: 4 }), 10_000).ok).toBe(true);
  });

  it('names a threshold the buyer has not reached — the one refusal they can act on', () => {
    const c = coupon({ minSubtotalAgorot: 15_000 });
    expect(checkCoupon(c, 14_999)).toEqual({ ok: false, reason: 'below-min' });
    expect(checkCoupon(c, 15_000).ok).toBe(true);
  });

  it('refuses a code that would take nothing off rather than storing a zero discount', () => {
    // An order carrying a coupon that discounted nothing is a support ticket with no answer.
    expect(checkCoupon(coupon({ kind: 'amount', value: 0.001 }), 10).ok).toBe(false);
  });

  it('is the same verdict wherever it runs', () => {
    // The property the whole feature rests on: the browser's preview and the server's charge come
    // from this one function over the same inputs, so they cannot disagree.
    const c = coupon({ kind: 'amount', value: 7.77 });
    expect(checkCoupon(c, 12_345)).toEqual(checkCoupon(c, 12_345));
  });
});

describe('isCouponLive / publicCoupon', () => {
  it('separates "offerable at all" from "works on this cart"', () => {
    // A threshold the buyer has not reached must NOT hide the field — it is a reason to show a
    // message, not a reason to pretend the store runs no promotion.
    const c = coupon({ minSubtotalAgorot: 50_000 });
    expect(isCouponLive(c)).toBe(true);
    expect(checkCoupon(c, 1000).ok).toBe(false);
  });

  it('never hands the buyer the numbers behind the promotion', () => {
    const pub = publicCoupon(coupon({ maxUses: 3, usedCount: 2 }));
    expect(pub).toEqual({ code: 'SAVE10', kind: 'percent', value: 10, minSubtotalAgorot: 0 });
    expect(Object.keys(pub)).not.toContain('usedCount');
    expect(Object.keys(pub)).not.toContain('maxUses');
    expect(Object.keys(pub)).not.toContain('id');
  });
});

describe('parseCouponInput', () => {
  it('accepts the two fields a seller must fill and defaults the rest', () => {
    const parsed = parseCouponInput({ code: 'summer 10', kind: 'percent', value: '15' });
    expect(parsed).toEqual({
      ok: true,
      value: { code: 'SUMMER10', kind: 'percent', value: 15, minSubtotalAgorot: 0, active: true },
    });
  });

  it('clamps a percent into the band every other discount uses', () => {
    expect(parseCouponInput({ code: 'X', value: '400' })).toMatchObject({ value: { value: 95 } });
    expect(parseCouponInput({ code: 'X', value: '0.4' })).toMatchObject({ value: { value: 1 } });
  });

  it('refuses rather than silently storing something else', () => {
    // Each of these is "I typed something and it saved as something different" — the failure that
    // puts an unredeemable code on a printed flyer.
    expect(parseCouponInput({ code: 'קיץ', value: '10' })).toEqual({ ok: false, error: 'code' });
    expect(parseCouponInput({ code: 'X', value: 'abc' })).toEqual({ ok: false, error: 'value' });
    expect(parseCouponInput({ code: 'X', value: '0' })).toEqual({ ok: false, error: 'value' });
    expect(parseCouponInput({ code: 'X', kind: 'amount', value: String(MAX_COUPON_AMOUNT + 1) }))
      .toEqual({ ok: false, error: 'value' });
    expect(parseCouponInput({ code: 'X', value: '10', maxUses: String(MAX_COUPON_USES + 1) }))
      .toEqual({ ok: false, error: 'uses' });
    expect(parseCouponInput({ code: 'X', value: '10', maxUses: '0' })).toEqual({ ok: false, error: 'uses' });
    // A window that closes before it opens stores as a permanently dead code showing two plausible
    // dates, and a coupon has no banner whose absence the seller would notice.
    expect(parseCouponInput({ code: 'X', value: '10', startsAt: '2026-09-01', endsAt: '2026-08-01' }))
      .toEqual({ ok: false, error: 'dates' });
  });

  it('reads a blank optional field as "none", never as zero', () => {
    // `maxUses: 0` would be a code that can never be used; `minSubtotal: ''` must not become a
    // threshold at all.
    const parsed = parseCouponInput({ code: 'X', value: '10', maxUses: '', minSubtotal: '' });
    expect(parsed.ok && parsed.value.maxUses).toBeUndefined();
    expect(parsed.ok && parsed.value.minSubtotalAgorot).toBe(0);
  });

  it('converts the ₪ fields to integer agorot at the boundary', () => {
    const parsed = parseCouponInput({ code: 'X', kind: 'amount', value: '25.5', minSubtotal: '150' });
    expect(parsed.ok && parsed.value.value).toBe(25.5);          // the seller's own unit, for their form
    expect(parsed.ok && parsed.value.minSubtotalAgorot).toBe(15_000);
  });

  it('does not switch a paused code back on when the checkbox is absent', () => {
    // An unchecked checkbox sends nothing. Defaulting `active` to true is right for a NEW code and
    // wrong for an edit, which is why the dashboard sends '0' explicitly — pinned here so a future
    // caller that forgets fails this instead of quietly republishing a code the seller stopped.
    expect(parseCouponInput({ code: 'X', value: '10', active: '0' })).toMatchObject({ value: { active: false } });
    expect(parseCouponInput({ code: 'X', value: '10' })).toMatchObject({ value: { active: true } });
  });
});
