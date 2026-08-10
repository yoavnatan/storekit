/** Discounts & sales — the ONE place a displayed/charged price is derived.
 *
 *  Two levers, deliberately only two:
 *    1. `StoreProduct.discount` — the seller marks a single product down (percent or ₪). This is
 *                                 also what "these selected products" resolves to: the bulk action
 *                                 writes the same per-product record, so N chosen items and one
 *                                 chosen item are the same thing in the data.
 *    2. `Store.sale`            — a sale the seller announces, optionally carrying a percent.
 *                                 Its SCOPE is the whole store, one category subtree
 *                                 (`categoryIds`), or an explicit list of products
 *                                 (`productIds`) — one record, three scopes, no second
 *                                 mechanism to keep in sync.
 *
 *  The two levers never STACK — a seller can't give away 60% by running both at once. When both
 *  reach the same product the buyer gets the BETTER of the two, and that is a deliberate choice
 *  over "the product's own discount always wins": the store banner is a public promise ("30% off
 *  everything"), so a product carrying its own 5% markdown must not quietly charge more than the
 *  banner the shopper just read. The product's own discount still decides whenever it is the
 *  better price, and it is the ONLY thing that applies outside a scoped sale.
 *
 *  Pure/isomorphic: no I/O, no `data/*.json`, safe on both server and client. Every render
 *  surface (cards, product page, modal, cart, feed, JSON-LD) and `/api/checkout`'s
 *  server-side re-validation call `resolvePrice` rather than reading `product.price`.
 */

import { roundMoney } from './money.js';
// A sale's endsAt is a date-only string on a synthetic calendar, not an instant — the
// `calendar*` family, never the `business*` one (business-day.ts's file header says why).
import { calendarDayISO, isDayISO } from './business-day.js';

export type DiscountType = 'percent' | 'amount';

export const MIN_DISCOUNT_PERCENT = 1;
export const MAX_DISCOUNT_PERCENT = 95;

export interface ProductDiscount {
  type: DiscountType;
  /** Percent off (1–95) or a flat ₪ amount off — per `type`. */
  value: number;
  /** Seller's choice whether the storefront shows the sale badge on this product. Default true. */
  showBadge?: boolean;
  /** Optional schedule, date-only `YYYY-MM-DD` in local time. `endsAt` is inclusive (the sale
   *  runs through the end of that day). Absent = runs until the seller removes it. */
  startsAt?: string;
  endsAt?: string;
}

export interface StoreSale {
  /** Seller's on/off switch — the whole feature is off until this is true. */
  active: boolean;
  /** Headline shown on the banner, e.g. "מבצע סוף עונה". Required for the banner to render. */
  title: string;
  /** One optional supporting line under the headline. */
  text?: string;
  /** Optional automatic percent off every IN-SCOPE product that has no discount of its own.
   *  Absent = the sale is an announcement only and no price changes. */
  percent?: number;
  /** The FIRST category the seller scoped the sale to. Kept as its own field because it is what
   *  every deployed reader before multi-pick looked at — during a rolling deploy the old code
   *  keeps labelling the banner with a real category instead of nothing (prices were never at
   *  risk: those come from `categoryIds`, which is the full union either way). New code reads
   *  `salePickedCategoryIds()`, never this. Absent = the sale covers the whole store. */
  categoryId?: string;
  /** Every category the seller picked, in the order they picked them — the scope as a HUMAN
   *  chose it, which is what the banner names. Distinct from `categoryIds` below, which is that
   *  same choice expanded downward for matching. Absent on a sale saved before multi-pick, so
   *  read it through `salePickedCategoryIds()`, which falls back to `categoryId`. */
  pickedCategoryIds?: string[];
  /** An explicit product list, when the seller scoped the sale to hand-picked items. Takes
   *  precedence over `categoryIds` (the UI only ever sets one of the two). Validated
   *  server-side against the store's own catalog. Empty/absent = not product-scoped. */
  productIds?: string[];
  /** That category AND every category beneath it, flattened server-side at save time
   *  (store-sale-scope.ts). Stored rather than resolved per read so `resolvePrice` stays pure
   *  and isomorphic — it can run in the browser, where the category tree isn't available.
   *  Empty/absent = whole store. */
  categoryIds?: string[];
  /** Whether products discounted BY this store sale carry the badge. Default true. */
  showBadge?: boolean;
  startsAt?: string;
  endsAt?: string;
}

export interface PriceView {
  /** What the buyer actually pays. */
  price: number;
  /** The pre-discount price — rendered struck-through when `isDiscounted`. */
  basePrice: number;
  isDiscounted: boolean;
  /** Rounded whole percent off, for the badge. 0 when not discounted. */
  percentOff: number;
  /** Whether the storefront badge should render (seller-controlled, per lever). */
  showBadge: boolean;
  source: 'product' | 'store' | null;
}

/** Local `YYYY-MM-DD` — the schedule is a seller-facing calendar day, not a UTC instant. */
function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** ISO date strings compare correctly as plain strings — no Date parsing needed. */
export function isScheduleOpen(s: { startsAt?: string; endsAt?: string }, now: Date = new Date()): boolean {
  const today = dayKey(now);
  if (s.startsAt && today < s.startsAt) return false;
  if (s.endsAt && today > s.endsAt) return false;
  return true;
}

/** Price after a discount, rounded to agorot. Returns the base unchanged on bad input. */
export function discountedPrice(base: number, type: DiscountType, value: number): number {
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(value) || value <= 0) return base;
  const next = type === 'percent' ? base * (1 - value / 100) : base - value;
  return roundMoney(next);
}

/** A discount only counts if it lands strictly between 0 and the original price — a ₪-off
 *  larger than the price would otherwise produce a free or negative product. */
function usablePrice(base: number, next: number): boolean {
  return next > 0 && next < base;
}

const plain = (base: number): PriceView => ({
  price: base, basePrice: base, isDiscounted: false, percentOff: 0, showBadge: false, source: null,
});

/** The single price resolver. `sale` is the product's own store's sale (optional). */
export function resolvePrice(
  product: { id?: string; price: number; discount?: ProductDiscount; categoryId?: string },
  sale?: StoreSale | null,
  now: Date = new Date(),
): PriceView {
  const base = product.price;
  if (!Number.isFinite(base) || base <= 0) return plain(base);

  const candidates: Array<{ price: number; showBadge: boolean; source: 'product' | 'store' }> = [];

  const own = product.discount;
  if (own && isScheduleOpen(own, now)) {
    const next = discountedPrice(base, own.type, own.value);
    if (usablePrice(base, next)) candidates.push({ price: next, showBadge: own.showBadge !== false, source: 'product' });
  }

  if (sale?.active && sale.percent && sale.percent > 0 && isScheduleOpen(sale, now) && saleCoversProduct(sale, product)) {
    const next = discountedPrice(base, 'percent', sale.percent);
    if (usablePrice(base, next)) candidates.push({ price: next, showBadge: sale.showBadge !== false, source: 'store' });
  }

  if (!candidates.length) return plain(base);

  // Lowest price wins; a tie keeps the product's own record, which is first in the list.
  const best = candidates.reduce((a, b) => (b.price < a.price ? b : a), candidates[0]);
  return {
    price: best.price, basePrice: base, isDiscounted: true,
    percentOff: Math.round((1 - best.price / base) * 100),
    showBadge: best.showBadge,
    source: best.source,
  };
}

/**
 * The schedule of the discount that ACTUALLY WON, or undefined when nothing is discounted.
 *
 * Two outside systems need this window and they must never describe different sales: the product
 * page publishes when the price expires (`priceValidUntil` below) and the ad feed publishes the
 * whole range (`product-feed.ts`). Asking "which lever won" twice is how they would drift — a
 * product carrying a dated markdown that LOST to a bigger store-wide sale would otherwise have the
 * feed quoting the loser's dates against the winner's price.
 *
 * Only well-formed `YYYY-MM-DD` bounds come back (`isDayISO`): a stored `2026-02-30` is not a
 * shorter range, it is a value the consumer would publish as a date.
 */
export function activeDiscountWindow(
  product: { id?: string; price: number; discount?: ProductDiscount; categoryId?: string },
  sale?: StoreSale | null,
  now: Date = new Date(),
): { startsAt?: string; endsAt?: string } | undefined {
  const view = resolvePrice(product, sale, now);
  if (!view.isDiscounted) return undefined;
  const won = view.source === 'product' ? product.discount : sale;
  if (!won) return undefined;
  return {
    ...(won.startsAt && isDayISO(won.startsAt) ? { startsAt: won.startsAt } : {}),
    ...(won.endsAt && isDayISO(won.endsAt) ? { endsAt: won.endsAt } : {}),
  };
}

/**
 * The date the currently-shown price stops being the price — schema.org `priceValidUntil`, which
 * Google requires on a merchant listing offer and treats as "after this, the price is unknown".
 *
 * Derived from whichever discount actually WON (`PriceView.source`), never from whatever schedule
 * happens to exist: a product carrying a dated markdown that lost to a bigger store-wide sale
 * would otherwise publish an expiry belonging to a price nobody is being charged.
 *
 * **The off-by-one is the whole point.** `endsAt` here is INCLUSIVE — the sale runs through the
 * end of that day (see the field's own comment) — while `priceValidUntil` is the first day the
 * price no longer holds. So it is the day AFTER, computed in UTC because these are date-only
 * strings on a synthetic calendar, not instants (business-day.ts's distinction). Publishing the
 * inclusive last day instead would retire the rich result a day early, every time.
 *
 * Undefined when the price is not discounted, or the winning discount has no end date — an
 * open-ended price has no expiry to state, and omitting the property is how you say that.
 */
export function priceValidUntil(
  product: { id?: string; price: number; discount?: ProductDiscount; categoryId?: string },
  sale?: StoreSale | null,
  now: Date = new Date(),
): string | undefined {
  const endsAt = activeDiscountWindow(product, sale, now)?.endsAt;
  if (!endsAt) return undefined;
  const dayAfter = new Date(`${endsAt}T00:00:00Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  return calendarDayISO(dayAfter);
}

/** Convenience for the many call sites that only need the number to charge/display. */
export function effectivePrice(
  product: { id?: string; price: number; discount?: ProductDiscount; categoryId?: string },
  sale?: StoreSale | null,
  now: Date = new Date(),
): number {
  return resolvePrice(product, sale, now).price;
}

/** Is this product inside the sale's scope? An unscoped sale covers everything; a scoped one
 *  covers only products filed under the chosen category (or one beneath it), so a product with
 *  no category at all is never swept into a category sale. */
export function saleCoversProduct(sale: StoreSale, product: { id?: string; categoryId?: string }): boolean {
  if (sale.productIds?.length) return !!product.id && sale.productIds.includes(product.id);
  if (!sale.categoryIds?.length) return true;
  return !!product.categoryId && sale.categoryIds.includes(product.categoryId);
}

/** The categories the seller chose, newest field first and the pre-multi-pick `categoryId` as
 *  the fallback — every reader goes through here so a sale saved before multi-pick reads
 *  identically to one saved after it, with no migration and no per-caller `??` chain. */
export function salePickedCategoryIds(sale?: StoreSale | null): string[] {
  if (sale?.pickedCategoryIds?.length) return sale.pickedCategoryIds;
  return sale?.categoryId ? [sale.categoryId] : [];
}

/** True when the sale reaches only part of the catalog. Every surface that ANNOUNCES the sale
 *  (store banner, store card chip) must say so: a scoped sale shouting "-30%" across a whole
 *  store page promises a discount most of that page doesn't give — the same failure the banner
 *  and the percent were put in one record to prevent. */
export function isSaleScoped(sale: StoreSale): boolean {
  return !!(sale.productIds?.length || sale.categoryIds?.length);
}

/** Should the store page render the sale banner? Title-less or scheduled-out = no. */
export function isStoreSaleLive(sale?: StoreSale | null, now: Date = new Date()): boolean {
  return !!sale?.active && !!sale.title.trim() && isScheduleOpen(sale, now);
}
