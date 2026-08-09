/**
 * Coupon codes — the pure half.
 *
 * **A coupon is not a third price lever.** `discounts.ts` answers "what does this product COST",
 * and every consumer of that answer is public: the product page, the catalog, JSON-LD, the
 * sitemap, the Google/Meta feed. A coupon is a discount the buyer has to know about, which means
 * the published price must stay exactly what it was — see `migrations/0020_store_coupons.sql` for
 * why putting one in the resolver would put a figure in the feed that no page shows, and what that
 * costs when one Merchant Center serves every seller.
 *
 * So a coupon applies to the SUBTOTAL of one store's slice, after the two price levers have
 * already decided each line, and it writes the order-level discount slot `order_stores` already
 * has. Everything money-shaped about it is therefore already correct everywhere.
 *
 * This module is pure and isomorphic, like `discounts.ts` and for the same reason: the checkout
 * page applies a coupon in the browser to show the buyer a number, and `/api/checkout` re-derives
 * it server-side before charging. Two spellings of one calculation is how a display and a charge
 * drift apart, so there is one, and it runs in both places.
 *
 * Amounts here are integer agorot, not ILS — a coupon only ever meets money that is already in the
 * order pipeline (lib/money.ts), so there is nothing to round and nothing to round twice. The one
 * exception is `value`, which is what the seller TYPED and is percent-points or ILS by `kind`,
 * exactly as `StoreSubtotal.discount.value` is.
 */

import { isScheduleOpen, MIN_DISCOUNT_PERCENT, MAX_DISCOUNT_PERCENT } from './discounts.js';
import { toAgorot } from './money.js';

export type CouponKind = 'percent' | 'amount';

/** The seller's record. `usedCount`/`maxUses` are deliberately NOT part of what the buyer-facing
 *  endpoint returns — see `PublicCoupon`. */
export interface StoreCoupon {
  id: string;
  storeId: string;
  code: string;
  kind: CouponKind;
  /** Percent points (1–95) or ILS off, per `kind`. The seller's own number, round-tripped into
   *  their edit form unchanged. */
  value: number;
  /** Integer agorot. 0 = no threshold. */
  minSubtotalAgorot: number;
  /** `undefined` = unlimited. */
  maxUses?: number;
  usedCount: number;
  /** `YYYY-MM-DD`, local, `endsAt` inclusive — the same schedule as a discount or a sale. */
  startsAt?: string;
  endsAt?: string;
  active: boolean;
}

/** What a buyer is allowed to learn about a coupon: enough to apply it and to be told exactly why
 *  it did not apply, and nothing that would help someone map a store's promotion budget.
 *  `maxUses`/`usedCount` are absent on purpose — "3 left" is a number a seller may choose to
 *  advertise, never one an endpoint volunteers. */
export interface PublicCoupon {
  code: string;
  kind: CouponKind;
  value: number;
  minSubtotalAgorot: number;
}

/** Every reason a code can fail, as a code rather than a sentence — the buyer's page owns the
 *  wording (i18n) and `/api/checkout` owns the decision, so they must not share a string.
 *
 *  `unknown` covers "no such code" AND "exists but is switched off or out of its dates", and that
 *  collapse is deliberate: three distinct answers would turn the lookup endpoint into an oracle
 *  that confirms a guessed code exists. The two the buyer CAN act on stay separate, because both
 *  are about their own cart — `below-min` names the threshold and `exhausted` means somebody else
 *  got the last one. */
export type CouponRefusal = 'unknown' | 'below-min' | 'exhausted';

export const COUPON_CODE_MAX = 24;

/**
 * A typed code → the stored form, or `''`.
 *
 * Upper-cased and reduced to `A–Z 0–9 -`, so the buyer reading `summer 10` off a flyer and typing
 * `Summer-10` reaches the same row. This runs on BOTH sides — the seller's save and the buyer's
 * lookup — which is what makes the unique index a real uniqueness rule rather than one that a
 * space defeats.
 *
 * **This is deliberately NOT the slug rule (`url-base.ts#toSlug`), and it is written as a KEEP
 * list rather than the slug idiom's `[^a-z0-9-]` so that it cannot be mistaken for one.** A slug
 * keeps Hebrew, because a store or product name is content someone wrote in their own language.
 * A coupon code is the opposite kind of string: it is dictated over a phone, printed on a flyer
 * and typed on whatever keyboard layout the shopper has open, so a code that is only reachable in
 * one layout is a code half the buyers cannot redeem. Losing the Hebrew here is the feature; in a
 * slug it was the bug that guard exists to prevent.
 */
export function normalizeCouponCode(v: unknown): string {
  const kept = String(v ?? '').trim().toUpperCase().match(/[A-Z0-9-]+/g);
  return (kept ?? []).join('').slice(0, COUPON_CODE_MAX);
}

/**
 * Is this coupon offerable at all right now — before any cart is considered?
 *
 * Split from `checkCoupon` because it answers a different question in a different place: the
 * checkout page asks it (through the server) to decide whether to render a coupon field for a
 * store, and a store with no live code must show no field at all. Cart-dependent refusals
 * (`below-min`) deliberately do not belong here — a threshold the buyer has not reached yet is a
 * reason to show the field with a message, never a reason to hide it.
 */
export function isCouponLive(c: StoreCoupon, now: Date = new Date()): boolean {
  if (!c.active) return false;
  if (!isScheduleOpen(c, now)) return false;
  if (c.maxUses !== undefined && c.usedCount >= c.maxUses) return false;
  return true;
}

/**
 * What the code takes off this subtotal, in integer agorot.
 *
 * Clamped into `[0, subtotal]` at BOTH ends and that is load-bearing in both directions: a ₪50
 * code on a ₪30 cart must leave the slice at zero rather than negative (the buyer still pays
 * shipping, which is not the seller's to give away), and `reconcile.ts` reports any stored
 * discount that exceeds its own subtotal as a corrupt row — clamping here is what keeps a
 * perfectly ordinary voucher from being filed as data corruption.
 */
export function couponDiscountAgorot(c: Pick<StoreCoupon, 'kind' | 'value'>, subtotalAgorot: number): number {
  if (!Number.isFinite(subtotalAgorot) || subtotalAgorot <= 0) return 0;
  if (!Number.isFinite(c.value) || c.value <= 0) return 0;
  const raw = c.kind === 'percent'
    // Rounded once, here, off an integer — `percentOf` is the ILS-side definition and would hand
    // back a fractional shekel amount this pipeline has no way to hold.
    ? Math.round((subtotalAgorot * Math.min(c.value, MAX_DISCOUNT_PERCENT)) / 100)
    : toAgorot(c.value);
  return Math.max(0, Math.min(subtotalAgorot, raw));
}

export type CouponVerdict =
  | { ok: true; appliedAgorot: number }
  | { ok: false; reason: CouponRefusal };

/**
 * The whole decision, for one coupon against one store's subtotal. Used by the buyer's page to
 * show a number and by `/api/checkout` to charge one — the same function, so they cannot disagree.
 *
 * It does NOT decrement anything. Consuming a use is a write with its own race
 * (`store-coupons.ts#claimCoupon`), and the `exhausted` returned here is only the read-side
 * courtesy that keeps the common case from reaching it.
 */
export function checkCoupon(c: StoreCoupon, subtotalAgorot: number, now: Date = new Date()): CouponVerdict {
  if (!isCouponLive(c, now)) {
    return { ok: false, reason: c.maxUses !== undefined && c.usedCount >= c.maxUses ? 'exhausted' : 'unknown' };
  }
  if (subtotalAgorot < c.minSubtotalAgorot) return { ok: false, reason: 'below-min' };
  const appliedAgorot = couponDiscountAgorot(c, subtotalAgorot);
  // A code that comes to nothing is refused rather than applied as zero: an order carrying a coupon
  // that took nothing off is a support ticket, and "this code does nothing on this cart" is exactly
  // what `below-min` already says for the case a buyer can fix.
  if (appliedAgorot <= 0) return { ok: false, reason: 'below-min' };
  return { ok: true, appliedAgorot };
}

/** The narrowed shape the buyer's page gets. Its own function so the omission is a decision in one
 *  place rather than a field list an endpoint remembers to trim. */
export function publicCoupon(c: StoreCoupon): PublicCoupon {
  return { code: c.code, kind: c.kind, value: c.value, minSubtotalAgorot: c.minSubtotalAgorot };
}

export { MIN_DISCOUNT_PERCENT, MAX_DISCOUNT_PERCENT };
