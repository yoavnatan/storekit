/** Untrusted-input side of discounts: turn whatever a form / CSV row / JSON body claims into
 *  a typed `ProductDiscount` / `StoreSale`, or `undefined`. Kept apart from `discounts.ts`
 *  (which is pure price math) so the resolver never has to care where a value came from.
 *
 *  Nothing here trusts the client: percent is clamped to the allowed band, ₪-off is bounded
 *  by the price it applies to, and free text is length-capped before it can reach storage.
 *  Spam/keyword-stuffing screening of seller copy stays at the API layer, next to the other
 *  seller-text gates (see /api/store.ts).
 */

import {
  MAX_DISCOUNT_PERCENT, MIN_DISCOUNT_PERCENT,
  type DiscountType, type ProductDiscount, type StoreSale,
} from './discounts.js';
import { roundMoney } from './money.js';

export const SALE_TITLE_MAX = 60;
export const SALE_TEXT_MAX = 140;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function type(v: unknown): DiscountType {
  return String(v ?? '').trim().toLowerCase() === 'amount' ? 'amount' : 'percent';
}

/** `YYYY-MM-DD` or nothing — anything else is dropped rather than stored half-parsed. */
export function normalizeDay(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return fallback;
}

/** Clamp a discount value into a usable band for its type. `price` bounds a ₪-off so a
 *  seller can never store one that would make the product free or negative. */
export function clampDiscountValue(t: DiscountType, value: number, price?: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (t === 'percent') {
    return Math.min(MAX_DISCOUNT_PERCENT, Math.max(MIN_DISCOUNT_PERCENT, Math.round(value)));
  }
  const rounded = roundMoney(value);
  if (price !== undefined && Number.isFinite(price) && price > 0) {
    // Leave at least one agora on the price — see discounts.ts#usablePrice.
    return Math.min(rounded, roundMoney(price - 0.01));
  }
  return rounded;
}

export interface DiscountInput {
  type?: unknown;
  value?: unknown;
  showBadge?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

/** `undefined` means "no discount" — a zero/blank/unusable value removes it rather than
 *  storing an inert record, so `product.discount` existing always means it means something. */
export function normalizeProductDiscount(input: DiscountInput | null | undefined, price?: number): ProductDiscount | undefined {
  if (!input) return undefined;
  const t = type(input.type);
  const value = clampDiscountValue(t, num(input.value), price);
  if (!value) return undefined;

  const discount: ProductDiscount = { type: t, value };
  if (bool(input.showBadge, true) === false) discount.showBadge = false;
  const startsAt = normalizeDay(input.startsAt);
  const endsAt = normalizeDay(input.endsAt);
  if (startsAt) discount.startsAt = startsAt;
  // An end before the start would silently mean "never runs" — drop it instead of storing it.
  if (endsAt && (!startsAt || endsAt >= startsAt)) discount.endsAt = endsAt;
  return discount;
}

/** Resolved + ownership-checked by the caller (store-sale-scope.ts). Exactly one of the two
 *  shapes is ever populated — the UI offers one scope at a time. */
export interface SaleScopeInput {
  categoryId?: string;
  pickedCategoryIds?: string[];
  categoryIds?: string[];
  productIds?: string[];
}

export interface StoreSaleInput {
  active?: unknown;
  title?: unknown;
  text?: unknown;
  percent?: unknown;
  showBadge?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
}

/** A store sale with neither a title nor a percent carries no information — dropped.
 *
 *  `scope` is resolved by the CALLER (store-sale-scope.ts, which validates the category belongs
 *  to this store) and never read off `input` — a client-sent category id list would let a seller
 *  scope a sale to ids they don't own. */
export function normalizeStoreSale(
  input: StoreSaleInput | null | undefined,
  scope?: SaleScopeInput,
): StoreSale | undefined {
  if (!input) return undefined;
  const title = String(input.title ?? '').trim().slice(0, SALE_TITLE_MAX);
  const text = String(input.text ?? '').trim().slice(0, SALE_TEXT_MAX);
  const rawPercent = num(input.percent);
  const percent = Number.isFinite(rawPercent) && rawPercent > 0
    ? clampDiscountValue('percent', rawPercent)
    : 0;
  if (!title && !percent) return undefined;

  const sale: StoreSale = { active: bool(input.active, false), title };
  if (text) sale.text = text;
  if (percent) sale.percent = percent;
  if (scope?.productIds?.length) {
    sale.productIds = scope.productIds;
  } else if (scope?.categoryIds?.length && scope.categoryId) {
    sale.categoryId = scope.categoryId;
    if (scope.pickedCategoryIds?.length) sale.pickedCategoryIds = scope.pickedCategoryIds;
    sale.categoryIds = scope.categoryIds;
  }
  if (bool(input.showBadge, true) === false) sale.showBadge = false;
  const startsAt = normalizeDay(input.startsAt);
  const endsAt = normalizeDay(input.endsAt);
  if (startsAt) sale.startsAt = startsAt;
  if (endsAt && (!startsAt || endsAt >= startsAt)) sale.endsAt = endsAt;
  return sale;
}
