import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { storeSliceTotalAgorot } from '../src/lib/order-totals';

// One definition of "what this store's slice of the order came to" (order-totals.ts).
// It was computed inline in five places and three of them dropped the seller's discount:
// the seller's order card (SSR + the client rebuild), the "sort by amount" key, and the
// buyer's own order history — which then contradicted the discount-aware total printed at
// the top of the very same card.

describe('storeSliceTotalAgorot', () => {
  it('is goods + shipping when there is no discount', () => {
    expect(storeSliceTotalAgorot({ subtotalAgorot: 100, shippingAgorot: 20 })).toBe(120);
  });

  it('subtracts the applied discount', () => {
    expect(storeSliceTotalAgorot({ subtotalAgorot: 100, shippingAgorot: 20, discount: { appliedAgorot: 30 } })).toBe(90);
  });

  it('never lets the discount eat the shipping fee (a full-subtotal discount still owes carriage)', () => {
    expect(storeSliceTotalAgorot({ subtotalAgorot: 100, shippingAgorot: 20, discount: { appliedAgorot: 100 } })).toBe(20);
  });

  it('is exact by construction, with no rounding step left to get wrong', () => {
    // This used to assert that `sumMoney` trimmed the tail off `0.1 + 0.2` (0.30000000000000004).
    // Integers have no tail: the amounts are agorot since the `orders` migration, so the addition
    // that needed correcting cannot produce anything to correct.
    expect(storeSliceTotalAgorot({ subtotalAgorot: 10, shippingAgorot: 20 })).toBe(30);
  });

  it('a missing subtotal row is 0, not NaN', () => {
    expect(storeSliceTotalAgorot(undefined)).toBe(0);
  });
});

describe('no surface recomputes an order total inline', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(ts|astro)$/.test(e.name) ? [p] : [];
    });
  }

  // `<something>.subtotalAgorot + <something>.shippingAgorot` — the exact shape every one of the bugs had.
  // Cart-side math (checkout, before an order or a discount exists) uses plain locals and is a
  // different question, so it does not match this pattern.
  const INLINE_TOTAL = /\.subtotalAgorot\s*\+\s*[\w.[\]!?'"]*\bshipping\b/;

  it('every order surface goes through order-totals.ts', () => {
    const offenders = walk('src')
      .filter((f) => !f.endsWith('lib/order-totals.ts'))
      .filter((f) => INLINE_TOTAL.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
