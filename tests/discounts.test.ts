/* eslint-disable sonarjs/no-floating-point-equality -- exactness is the property under test.
 * These functions round money to agorot, so `toBe(71.92)` asserts the rounding landed on the
 * agora; a tolerance would pass on the drift the rounding exists to prevent. */

import { describe, expect, it } from 'vitest';
import {
  discountedPrice, effectivePrice, isSaleScoped, isScheduleOpen, isStoreSaleLive, resolvePrice, saleCoversProduct,
  type ProductDiscount, type StoreSale,
} from '../src/lib/discounts.js';
import { clampDiscountValue, normalizeDay, normalizeProductDiscount, normalizeStoreSale } from '../src/lib/discount-input.js';
import { validateRows, type RawImportRow } from '../src/lib/csv-bulk.js';
import { formatPrice } from '../src/config/store.config.js';

const NOW = new Date('2026-07-29T10:00:00');

describe('discountedPrice', () => {
  it('takes a percentage off and rounds to agorot', () => {
    expect(discountedPrice(89.9, 'percent', 20)).toBe(71.92);
    expect(discountedPrice(100, 'percent', 25)).toBe(75);
  });

  it('takes a flat amount off', () => {
    expect(discountedPrice(129.9, 'amount', 30)).toBe(99.9);
  });

  it('leaves the price alone for a non-positive or non-finite input', () => {
    expect(discountedPrice(50, 'percent', 0)).toBe(50);
    expect(discountedPrice(50, 'amount', NaN)).toBe(50);
    expect(discountedPrice(0, 'percent', 20)).toBe(0);
  });
});

describe('formatPrice — agorot', () => {
  // A discount routinely produces a half-shekel price; "49.5 ₪" next to a struck-through
  // "55 ₪" reads as a cut-off number, not a price.
  it('shows two digits when there are agorot, and none when the price is round', () => {
    expect(formatPrice(49.5)).toBe('49.50 ₪');
    expect(formatPrice(71.92)).toBe('71.92 ₪');
    expect(formatPrice(100)).toBe('100 ₪');
    expect(formatPrice(50000)).toBe('50,000 ₪');
  });

  it('never leaves a lone trailing digit from floating-point drift', () => {
    expect(formatPrice(discountedPrice(89.9, 'percent', 50))).toBe('44.95 ₪');
    expect(formatPrice(discountedPrice(55, 'percent', 10))).toBe('49.50 ₪');
  });
});

describe('isScheduleOpen', () => {
  it('is open with no dates at all', () => {
    expect(isScheduleOpen({}, NOW)).toBe(true);
  });

  it('is closed before the start and after the end, open on both boundary days', () => {
    expect(isScheduleOpen({ startsAt: '2026-07-30' }, NOW)).toBe(false);
    expect(isScheduleOpen({ startsAt: '2026-07-29' }, NOW)).toBe(true);
    expect(isScheduleOpen({ endsAt: '2026-07-28' }, NOW)).toBe(false);
    // endsAt is inclusive — the sale runs through the whole of its last day.
    expect(isScheduleOpen({ endsAt: '2026-07-29' }, NOW)).toBe(true);
  });
});

describe('resolvePrice', () => {
  const percent20: ProductDiscount = { type: 'percent', value: 20 };
  const sale10: StoreSale = { active: true, title: 'סוף עונה', percent: 10 };

  it('returns the plain price when nothing is running', () => {
    const view = resolvePrice({ price: 50 }, undefined, NOW);
    expect(view).toMatchObject({ price: 50, basePrice: 50, isDiscounted: false, percentOff: 0, source: null });
  });

  it('applies the product\'s own discount and reports the whole percent off', () => {
    const view = resolvePrice({ price: 50, discount: percent20 }, undefined, NOW);
    expect(view).toMatchObject({ price: 40, basePrice: 50, isDiscounted: true, percentOff: 20, source: 'product' });
  });

  it('applies the store sale to a product with no discount of its own', () => {
    expect(resolvePrice({ price: 50 }, sale10, NOW)).toMatchObject({ price: 45, source: 'store' });
  });

  it('never stacks — and the buyer gets the BETTER of the two', () => {
    // Product 20% beats store 10%.
    expect(resolvePrice({ price: 50, discount: percent20 }, sale10, NOW)).toMatchObject({ price: 40, source: 'product' });
    // …and the store sale wins when IT is the better price: the banner promised 30% off, so a
    // product carrying its own smaller markdown must not charge more than the banner says.
    const sale30: StoreSale = { active: true, title: 'סוף עונה', percent: 30 };
    const own5: ProductDiscount = { type: 'percent', value: 5 };
    expect(resolvePrice({ price: 100, discount: own5 }, sale30, NOW)).toMatchObject({ price: 70, source: 'store' });
    // Neither is ever added to the other — 30% + 5% would be 66.5.
    expect(resolvePrice({ price: 100, discount: own5 }, sale30, NOW).price).not.toBe(66.5);
  });

  it('falls back to the store sale when the product\'s own discount is out of its date window', () => {
    const expired: ProductDiscount = { type: 'percent', value: 20, endsAt: '2026-07-01' };
    expect(resolvePrice({ price: 50, discount: expired }, sale10, NOW)).toMatchObject({ price: 45, source: 'store' });
  });

  it('ignores a ₪-off that would make the product free or negative', () => {
    expect(resolvePrice({ price: 50, discount: { type: 'amount', value: 50 } }, undefined, NOW).isDiscounted).toBe(false);
    expect(resolvePrice({ price: 50, discount: { type: 'amount', value: 80 } }, undefined, NOW).price).toBe(50);
  });

  it('ignores an inactive store sale, and one with no percent (banner-only)', () => {
    expect(resolvePrice({ price: 50 }, { ...sale10, active: false }, NOW).isDiscounted).toBe(false);
    expect(resolvePrice({ price: 50 }, { active: true, title: 'הודעה' }, NOW).isDiscounted).toBe(false);
  });

  it('honours the seller\'s badge choice per lever', () => {
    expect(resolvePrice({ price: 50, discount: { ...percent20, showBadge: false } }, undefined, NOW).showBadge).toBe(false);
    expect(resolvePrice({ price: 50 }, { ...sale10, showBadge: false }, NOW).showBadge).toBe(false);
    expect(resolvePrice({ price: 50, discount: percent20 }, undefined, NOW).showBadge).toBe(true);
  });

  it('effectivePrice is the same number resolvePrice reports', () => {
    expect(effectivePrice({ price: 50, discount: percent20 }, sale10, NOW)).toBe(40);
  });
});

describe('resolvePrice — category-scoped sale', () => {
  // The seller picks one category; the API flattens it plus everything beneath it into
  // `categoryIds` (store-sale-scope.ts). Here that list is already resolved.
  const coats: StoreSale = { active: true, title: 'מעילים', percent: 20, categoryId: 'c-outer', categoryIds: ['c-outer', 'c-coats'] };

  it('discounts a product filed in the scoped category', () => {
    expect(resolvePrice({ price: 100, categoryId: 'c-outer' }, coats, NOW).price).toBe(80);
  });

  it('discounts a product in a SUBcategory beneath it', () => {
    expect(resolvePrice({ price: 100, categoryId: 'c-coats' }, coats, NOW).price).toBe(80);
  });

  it('leaves a product in another category at full price', () => {
    expect(resolvePrice({ price: 100, categoryId: 'c-shoes' }, coats, NOW).isDiscounted).toBe(false);
  });

  it('never sweeps in an uncategorised product', () => {
    expect(resolvePrice({ price: 100 }, coats, NOW).isDiscounted).toBe(false);
  });

  it('an unscoped sale still covers everything, categorised or not', () => {
    const all: StoreSale = { active: true, title: 'הכל', percent: 20 };
    expect(resolvePrice({ price: 100 }, all, NOW).price).toBe(80);
    expect(resolvePrice({ price: 100, categoryId: 'c-shoes' }, all, NOW).price).toBe(80);
  });

  it('the better price wins inside the scope', () => {
    expect(resolvePrice({ price: 100, categoryId: 'c-coats', discount: { type: 'percent', value: 40 } }, coats, NOW))
      .toMatchObject({ price: 60, source: 'product' });
    expect(resolvePrice({ price: 100, categoryId: 'c-coats', discount: { type: 'percent', value: 5 } }, coats, NOW))
      .toMatchObject({ price: 80, source: 'store' });
  });

  it('and still applies OUTSIDE the scope — a scoped store sale never suppresses it', () => {
    expect(resolvePrice({ price: 100, categoryId: 'c-shoes', discount: { type: 'percent', value: 40 } }, coats, NOW))
      .toMatchObject({ price: 60, source: 'product' });
  });

  it('saleCoversProduct is the scope test on its own', () => {
    expect(saleCoversProduct(coats, { categoryId: 'c-coats' })).toBe(true);
    expect(saleCoversProduct(coats, { categoryId: 'c-shoes' })).toBe(false);
    expect(saleCoversProduct({ active: true, title: 'הכל' }, {})).toBe(true);
  });
});

describe('resolvePrice — product-scoped sale', () => {
  const picked: StoreSale = { active: true, title: 'נבחרים', percent: 25, productIds: ['p1', 'p2'] };

  it('covers only the listed products', () => {
    expect(resolvePrice({ id: 'p1', price: 100 }, picked, NOW).price).toBe(75);
    expect(resolvePrice({ id: 'p3', price: 100 }, picked, NOW).isDiscounted).toBe(false);
  });

  it('a product list wins over a category list — the UI only ever sets one', () => {
    const both: StoreSale = { ...picked, categoryIds: ['c-a'] };
    expect(saleCoversProduct(both, { id: 'p1', categoryId: 'c-z' })).toBe(true);
    expect(saleCoversProduct(both, { id: 'p9', categoryId: 'c-a' })).toBe(false);
  });

  it('a product with no id is never swept in', () => {
    expect(saleCoversProduct(picked, {})).toBe(false);
  });

  // The "better of the two" comparison only happens where BOTH levers reach the same product.
  // Outside the sale's scope there is only one candidate, so a product's own discount applies
  // exactly as set — even when it is smaller than the sale the rest of the store is running.
  it('a product OUTSIDE the scope keeps its own discount, however small', () => {
    const own2: ProductDiscount = { type: 'percent', value: 2 };
    expect(resolvePrice({ id: 'p9', price: 100, discount: own2 }, picked, NOW))
      .toMatchObject({ price: 98, source: 'product' });
  });
});

describe('isSaleScoped', () => {
  // Drives whether an announcing surface (banner, store-card chip) may quote a bare percent.
  it('is true for a product list or a category subtree, false for a store-wide sale', () => {
    expect(isSaleScoped({ active: true, title: 'x', percent: 30 })).toBe(false);
    expect(isSaleScoped({ active: true, title: 'x', percent: 30, productIds: ['p1'] })).toBe(true);
    expect(isSaleScoped({ active: true, title: 'x', percent: 30, categoryIds: ['c1'] })).toBe(true);
    // An empty list is not a scope — it would silently hide the percent on a store-wide sale.
    expect(isSaleScoped({ active: true, title: 'x', percent: 30, productIds: [] })).toBe(false);
  });
});

describe('normalizeStoreSale — scope', () => {
  it('records the scope the CALLER resolved, never one off the raw input', () => {
    const sale = normalizeStoreSale(
      { active: '1', title: 'מעילים', percent: 20, categoryIds: ['spoofed'] } as Record<string, unknown>,
      { categoryId: 'c-outer', categoryIds: ['c-outer', 'c-coats'] },
    );
    expect(sale).toMatchObject({ categoryId: 'c-outer', categoryIds: ['c-outer', 'c-coats'] });
  });

  it('stores a product scope when the caller resolved one, and drops the category shape', () => {
    const sale = normalizeStoreSale(
      { active: '1', title: 'נבחרים', percent: 25 },
      { productIds: ['p1', 'p2'] },
    );
    expect(sale?.productIds).toEqual(['p1', 'p2']);
    expect(sale?.categoryIds).toBeUndefined();
  });

  it('is store-wide when no scope is passed', () => {
    const sale = normalizeStoreSale({ active: '1', title: 'הכל', percent: 20 });
    expect(sale?.categoryId).toBeUndefined();
    expect(sale?.categoryIds).toBeUndefined();
  });
});

describe('isStoreSaleLive', () => {
  it('needs active + a headline + an open window', () => {
    expect(isStoreSaleLive(undefined, NOW)).toBe(false);
    expect(isStoreSaleLive({ active: false, title: 'סייל' }, NOW)).toBe(false);
    expect(isStoreSaleLive({ active: true, title: '   ' }, NOW)).toBe(false);
    expect(isStoreSaleLive({ active: true, title: 'סייל', endsAt: '2026-07-01' }, NOW)).toBe(false);
    expect(isStoreSaleLive({ active: true, title: 'סייל' }, NOW)).toBe(true);
  });
});

describe('clampDiscountValue', () => {
  it('holds a percentage inside the allowed band and rounds it to whole percents', () => {
    expect(clampDiscountValue('percent', 120)).toBe(95);
    expect(clampDiscountValue('percent', 0.4)).toBe(1);
    expect(clampDiscountValue('percent', 12.6)).toBe(13);
  });

  it('bounds a ₪-off by the price it applies to, leaving at least one agora', () => {
    expect(clampDiscountValue('amount', 90, 50)).toBe(49.99);
    expect(clampDiscountValue('amount', 12.345, 50)).toBe(12.35);
  });

  it('is zero for a non-positive value', () => {
    expect(clampDiscountValue('percent', 0)).toBe(0);
    expect(clampDiscountValue('amount', -5, 50)).toBe(0);
  });
});

describe('normalizeProductDiscount', () => {
  it('drops a blank/zero value rather than storing an inert record', () => {
    expect(normalizeProductDiscount({ type: 'percent', value: '' })).toBeUndefined();
    expect(normalizeProductDiscount({ type: 'percent', value: 0 })).toBeUndefined();
    expect(normalizeProductDiscount(null)).toBeUndefined();
  });

  it('defaults an unknown type to percent and keeps the badge on by default', () => {
    expect(normalizeProductDiscount({ type: 'nonsense', value: '15' })).toEqual({ type: 'percent', value: 15 });
  });

  it('records showBadge only when the seller turned it off', () => {
    expect(normalizeProductDiscount({ type: 'percent', value: 15, showBadge: '0' })).toEqual({ type: 'percent', value: 15, showBadge: false });
  });

  it('keeps a valid window and drops an end that precedes the start', () => {
    expect(normalizeProductDiscount({ type: 'percent', value: 15, startsAt: '2026-08-01', endsAt: '2026-08-10' }))
      .toEqual({ type: 'percent', value: 15, startsAt: '2026-08-01', endsAt: '2026-08-10' });
    expect(normalizeProductDiscount({ type: 'percent', value: 15, startsAt: '2026-08-10', endsAt: '2026-08-01' }))
      .toEqual({ type: 'percent', value: 15, startsAt: '2026-08-10' });
  });

  it('rejects a malformed date instead of storing it half-parsed', () => {
    expect(normalizeDay('01/08/2026')).toBeUndefined();
    expect(normalizeDay('2026-08-01')).toBe('2026-08-01');
  });

  it('bounds a ₪-off against the price it is given', () => {
    expect(normalizeProductDiscount({ type: 'amount', value: 999 }, 50)).toEqual({ type: 'amount', value: 49.99 });
  });
});

describe('normalizeStoreSale', () => {
  it('drops a sale that carries neither a headline nor a percent', () => {
    expect(normalizeStoreSale({ active: '1' })).toBeUndefined();
  });

  it('keeps copy + percent and defaults to inactive', () => {
    expect(normalizeStoreSale({ title: '  סוף עונה  ', text: 'על הכל', percent: '30' }))
      .toEqual({ active: false, title: 'סוף עונה', text: 'על הכל', percent: 30 });
  });

  it('clamps an absurd percent into the allowed band', () => {
    expect(normalizeStoreSale({ active: 'on', title: 'סייל', percent: 300 })?.percent).toBe(95);
  });

  it('caps runaway copy rather than storing it', () => {
    const long = 'א'.repeat(500);
    expect(normalizeStoreSale({ active: '1', title: long })!.title.length).toBe(60);
  });
});

describe('CSV sale-price column', () => {
  const row = (cells: Record<string, string>): RawImportRow => ({ line: 2, cells });

  it('accepts a sale price below the regular price', () => {
    const [result] = validateRows([row({ name: 'חולצה', price: '100', salePrice: '80' })], new Set());
    expect(result!.action).toBe('create');
    expect(result!.input!.salePrice).toBe(80);
  });

  it('rejects a "sale" priced at or above the regular price', () => {
    expect(validateRows([row({ name: 'חולצה', price: '100', salePrice: '100' })], new Set())[0]!.errors).toContain('sale-price-invalid');
    expect(validateRows([row({ name: 'חולצה', price: '100', salePrice: '150' })], new Set())[0]!.errors).toContain('sale-price-invalid');
  });

  it('treats a blank cell as "leave unchanged" and 0 as "end the sale"', () => {
    expect(validateRows([row({ name: 'חולצה', price: '100' })], new Set())[0]!.input!.salePrice).toBeUndefined();
    expect(validateRows([row({ name: 'חולצה', price: '100', salePrice: '0' })], new Set())[0]!.input!.salePrice).toBe(0);
  });
});
