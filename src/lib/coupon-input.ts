/**
 * Untrusted input → a storable coupon, or a named refusal.
 *
 * Kept out of `coupons.ts` for the reason `discount-input.ts` is kept out of `discounts.ts`: the
 * resolver stays pure math that runs in a browser, and everything that has to distrust its caller
 * lives here. Everything a seller can type is bounded before it reaches storage — the percent to
 * the same 1–95 band every other discount uses, the ₪-off to something a cart can actually absorb,
 * the code to the stored character set, and the caps to positive integers.
 *
 * It returns a REASON rather than throwing or silently clamping, because two of these are things
 * the seller must be told: a code that lost its characters and a value that is not a number are
 * both "I typed something and it saved as something else" — the failure that makes a promotion go
 * out on a flyer with a code nobody can redeem.
 */

import { normalizeCouponCode, COUPON_CODE_MAX, MIN_DISCOUNT_PERCENT, MAX_DISCOUNT_PERCENT, type CouponKind } from './coupons.js';
import { normalizeDay } from './discount-input.js';
import { toAgorot, roundMoney } from './money.js';
import type { CouponWrite } from './store-coupons.js';

/** A ₪-off larger than this is a typo, not a promotion — and an unbounded one stored against a
 *  cart it cannot reach is a code that silently does nothing. High enough that no real voucher
 *  hits it; low enough that a stray extra digit does. */
export const MAX_COUPON_AMOUNT = 5000;
/** Same reasoning for the threshold: a minimum nobody's cart can reach is a switched-off code that
 *  looks switched on. */
export const MAX_COUPON_MIN_SUBTOTAL = 50_000;
export const MAX_COUPON_USES = 1_000_000;

export type CouponInputError = 'code' | 'value' | 'min-subtotal' | 'uses' | 'dates';

export type CouponParse =
  | { ok: true; value: CouponWrite }
  | { ok: false; error: CouponInputError };

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/** Absent / blank is a real answer here ("no cap", "no threshold"), so it must not read as zero —
 *  a `max_uses` of 0 would be a code that can never be used. */
function optionalNum(v: unknown): number | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const n = num(s);
  return Number.isFinite(n) ? n : NaN;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return fallback;
}

export interface CouponInput {
  code?: unknown;
  kind?: unknown;
  value?: unknown;
  minSubtotal?: unknown;
  maxUses?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  active?: unknown;
}

export function parseCouponInput(input: CouponInput): CouponParse {
  const code = normalizeCouponCode(input.code);
  // Rejected rather than clamped: `normalizeCouponCode` drops every character it does not store, so
  // an all-Hebrew code arrives here as `''`. Saving that as a blank code is the case this refusal
  // exists for — it would print on the flyer and match nothing.
  if (!code || code.length > COUPON_CODE_MAX) return { ok: false, error: 'code' };

  const kind: CouponKind = String(input.kind ?? '').trim().toLowerCase() === 'amount' ? 'amount' : 'percent';
  const raw = num(input.value);
  if (!Number.isFinite(raw) || raw <= 0) return { ok: false, error: 'value' };
  const value = kind === 'percent'
    ? Math.min(MAX_DISCOUNT_PERCENT, Math.max(MIN_DISCOUNT_PERCENT, Math.round(raw)))
    : roundMoney(raw);
  if (kind === 'amount' && (value <= 0 || value > MAX_COUPON_AMOUNT)) return { ok: false, error: 'value' };

  const minRaw = optionalNum(input.minSubtotal);
  if (minRaw !== undefined && (!Number.isFinite(minRaw) || minRaw < 0 || minRaw > MAX_COUPON_MIN_SUBTOTAL)) {
    return { ok: false, error: 'min-subtotal' };
  }
  const usesRaw = optionalNum(input.maxUses);
  if (usesRaw !== undefined && (!Number.isFinite(usesRaw) || usesRaw < 1 || usesRaw > MAX_COUPON_USES)) {
    return { ok: false, error: 'uses' };
  }

  const startsAt = normalizeDay(input.startsAt);
  const endsAt = normalizeDay(input.endsAt);
  // A window that closes before it opens is never what was meant, and it stores as a code that is
  // permanently dead while displaying two plausible dates. The store sale has the same trap; here
  // it is caught because a coupon has no banner a seller would notice missing.
  if (startsAt && endsAt && endsAt < startsAt) return { ok: false, error: 'dates' };

  const write: CouponWrite = {
    code,
    kind,
    value,
    minSubtotalAgorot: minRaw === undefined ? 0 : toAgorot(minRaw),
    active: bool(input.active, true),
  };
  if (usesRaw !== undefined) write.maxUses = Math.round(usesRaw);
  if (startsAt) write.startsAt = startsAt;
  if (endsAt) write.endsAt = endsAt;
  return { ok: true, value: write };
}
