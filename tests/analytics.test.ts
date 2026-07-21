import { describe, it, expect } from 'vitest';
import {
  buildFunnel,
  buildAnalyticsRates,
  topProductsByEvent,
  topAbandonedProducts,
  type AnalyticsData,
} from '../src/lib/analytics.js';

// Two days of traffic. Session 'a' repeats across both days — it must count ONCE
// per funnel stage (union of the daily id sets), never twice.
const data: AnalyticsData = {
  '2026-07-01': {
    page_view: { count: 10, visitors: ['a', 'b', 'c'] },
    view_item: { count: 5, visitors: ['a', 'b'], products: { p1: 3, p2: 2 } },
    add_to_cart: { count: 3, visitors: ['a'], products: { p1: 2, p2: 1 } },
    begin_checkout: { count: 1, visitors: ['a'] },
    purchase: { count: 1, visitors: ['a'], products: { p1: 1 } },
  },
  '2026-07-02': {
    page_view: { count: 4, visitors: ['a', 'd'] },
    view_item: { count: 2, visitors: ['d'], products: { p2: 2 } },
    add_to_cart: { count: 1, visitors: ['d'], products: { p3: 1 } },
  },
};

describe('buildFunnel', () => {
  it('measures each stage in DISTINCT sessions, unioned across the range', () => {
    const f = buildFunnel(data, '2026-07-01', '2026-07-02');
    const by = Object.fromEntries(f.map((s) => [s.event, s.sessions]));
    expect(by.page_view).toBe(4);      // a,b,c,d
    expect(by.view_item).toBe(3);      // a,b,d
    expect(by.add_to_cart).toBe(2);    // a,d
    expect(by.begin_checkout).toBe(1); // a
    expect(by.purchase).toBe(1);       // a
  });

  it('narrows to a single day when the range excludes the second', () => {
    const f = buildFunnel(data, '2026-07-01', '2026-07-01');
    expect(f.find((s) => s.event === 'page_view')!.sessions).toBe(3); // a,b,c only
  });

  it('returns all five stages in funnel order', () => {
    const f = buildFunnel(data, '2026-07-01', '2026-07-02');
    expect(f.map((s) => s.event)).toEqual(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
  });
});

describe('buildAnalyticsRates', () => {
  it('computes bounce / cart-abandonment / checkout-abandonment / conversion from sessions', () => {
    const r = buildAnalyticsRates(data, '2026-07-01', '2026-07-02');
    expect(r.bounceRate).toBeCloseTo(25);              // (4 sessions - 3 viewed) / 4
    expect(r.cartAbandonmentRate).toBeCloseTo(50);     // (2 added - 1 bought) / 2
    expect(r.checkoutAbandonmentRate).toBeCloseTo(0);  // 1 reached checkout, 1 bought
    expect(r.conversionRate).toBeCloseTo(25);          // 1 purchase / 4 sessions
  });

  it('zero-guards an empty range instead of dividing by zero', () => {
    const r = buildAnalyticsRates({}, '2026-07-01', '2026-07-02');
    expect(r).toMatchObject({ bounceRate: 0, cartAbandonmentRate: 0, checkoutAbandonmentRate: 0, conversionRate: 0 });
  });

  it('never reports a negative rate when a stage exceeds its predecessor', () => {
    // A purchase with no tracked add (e.g. add fired before the cookie existed):
    // cart abandonment must clamp to 0, not go negative.
    const odd: AnalyticsData = { '2026-07-01': { add_to_cart: { count: 1, visitors: ['x'] }, purchase: { count: 2, visitors: ['x', 'y'] } } };
    expect(buildAnalyticsRates(odd, '2026-07-01', '2026-07-01').cartAbandonmentRate).toBe(0);
  });
});

describe('topProductsByEvent', () => {
  it('ranks products by how many times they fired the event', () => {
    const top = topProductsByEvent(data, 'add_to_cart', '2026-07-01', '2026-07-02');
    expect(top[0]).toEqual({ productId: 'p1', count: 2 });
    expect(top.map((p) => p.productId).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('honours the limit', () => {
    expect(topProductsByEvent(data, 'add_to_cart', '2026-07-01', '2026-07-02', 1)).toHaveLength(1);
  });
});

describe('topAbandonedProducts', () => {
  it('reports added-minus-purchased, drops fully-converted products, sorts by gap', () => {
    const ab = topAbandonedProducts(data, '2026-07-01', '2026-07-02');
    const p1 = ab.find((p) => p.productId === 'p1')!;
    expect(p1).toEqual({ productId: 'p1', added: 2, purchased: 1, abandoned: 1 });
    // p2 added once, never bought → abandoned 1; p3 added once → abandoned 1.
    expect(ab.every((p) => p.abandoned > 0)).toBe(true);
  });
});
