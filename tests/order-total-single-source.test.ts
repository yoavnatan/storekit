import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { storeSliceTotal } from '../src/lib/order-totals';

// One definition of "what this store's slice of the order came to" (order-totals.ts).
// It was computed inline in five places and three of them dropped the seller's discount:
// the seller's order card (SSR + the client rebuild), the "sort by amount" key, and the
// buyer's own order history — which then contradicted the discount-aware total printed at
// the top of the very same card.

describe('storeSliceTotal', () => {
  it('is goods + shipping when there is no discount', () => {
    expect(storeSliceTotal({ subtotal: 100, shipping: 20 })).toBe(120);
  });

  it('subtracts the applied discount', () => {
    expect(storeSliceTotal({ subtotal: 100, shipping: 20, discount: { applied: 30 } })).toBe(90);
  });

  it('never lets the discount eat the shipping fee (a full-subtotal discount still owes carriage)', () => {
    expect(storeSliceTotal({ subtotal: 100, shipping: 20, discount: { applied: 100 } })).toBe(20);
  });

  it('rounds through money.ts rather than accumulating float error', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in raw float — sumMoney is what makes this exact.
    expect(String(storeSliceTotal({ subtotal: 0.1, shipping: 0.2 }))).toBe('0.3');
  });

  it('a missing subtotal row is 0, not NaN', () => {
    expect(storeSliceTotal(undefined)).toBe(0);
  });
});

describe('no surface recomputes an order total inline', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(ts|astro)$/.test(e.name) ? [p] : [];
    });
  }

  // `<something>.subtotal + <something>.shipping` — the exact shape every one of the bugs had.
  // Cart-side math (checkout, before an order or a discount exists) uses plain locals and is a
  // different question, so it does not match this pattern.
  const INLINE_TOTAL = /\.subtotal\s*\+\s*[\w.[\]!?'"]*\bshipping\b/;

  it('every order surface goes through order-totals.ts', () => {
    const offenders = walk('src')
      .filter((f) => !f.endsWith('lib/order-totals.ts'))
      .filter((f) => INLINE_TOTAL.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
