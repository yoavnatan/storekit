import { describe, it, expect, vi } from 'vitest';
import type { Order } from '../src/lib/orders.js';

// buildPerformanceSummary reads page-view data off disk via store-pageviews.js.
// Mock it so a test can inject a controlled daily series (total + visitor ids)
// and assert the unique-visitor union logic. Rows not in the fixture zero-fill,
// so the profitability tests below (which use a store with no fixture) are
// unaffected. `vi.hoisted` lets the fixture be referenced inside the hoisted
// factory.
const { VISIT_FIXTURE, PRODUCT_VIEW_FIXTURE } = vi.hoisted(() => ({
  VISIT_FIXTURE: {} as Record<string, { date: string; views: number; visitors: string[] }[]>,
  PRODUCT_VIEW_FIXTURE: {} as Record<string, { date: string; views: number }[]>,
}));
function fillDates(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }
  return dates;
}
vi.mock('../src/lib/store-pageviews.js', () => ({
  getDailyPageViews: (slug: string, from: string, to: string) => {
    const byDate = new Map((VISIT_FIXTURE[slug] ?? []).map((r) => [r.date, r]));
    return fillDates(from, to).map((date) => byDate.get(date) ?? { date, views: 0, visitors: [] });
  },
}));
// buildProductPerformance reads per-product views off disk via product-pageviews.js.
vi.mock('../src/lib/product-pageviews.js', () => ({
  getProductDailyViews: (productId: string, from: string, to: string) => {
    const byDate = new Map((PRODUCT_VIEW_FIXTURE[productId] ?? []).map((r) => [r.date, r]));
    return fillDates(from, to).map((date) => byDate.get(date) ?? { date, views: 0 });
  },
}));

const { buildPerformanceSummary, buildProductPerformance } = await import('../src/lib/seller-performance.js');

// Builds a minimal paid order for one store on a given date. Only the fields
// buildPerformanceSummary actually reads are populated.
function makeOrder(id: string, storeSlug: string, subtotal: number, createdAt: string, items: Order['items'] = [], discountApplied = 0): Order {
  return {
    id,
    buyerName: 'x', buyerEmail: 'x@x.co', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    items,
    storeSubtotals: { [storeSlug]: { storeName: 'S', subtotal, shipping: 0, ...(discountApplied ? { discount: { type: 'amount', value: discountApplied, applied: discountApplied } } : {}) } },
    shippingAmount: 0,
    totalAmount: subtotal,
    paymentStatus: 'paid',
    shippingStatus: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}

const STORE = 'my-store';

describe('buildPerformanceSummary — profitability (commission / net profit)', () => {
  it('splits gross revenue into platform commission and net profit at the given rate', () => {
    const orders = [
      makeOrder('o1', STORE, 1000, '2026-07-10T10:00:00.000Z'),
      makeOrder('o2', STORE, 500, '2026-07-12T10:00:00.000Z'),
    ];
    const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day', 10);
    expect(s.totalRevenue).toBe(1500);
    expect(s.commissionRate).toBe(10);
    expect(s.platformCommission).toBe(150); // 10% of 1500
    expect(s.netProfit).toBe(1350);
    // net + commission must reconcile back to gross exactly (no rounding drift)
    expect(s.netProfit + s.platformCommission).toBe(s.totalRevenue);
  });

  it('commission is net of a seller discount (uses the same net basis as revenue)', () => {
    const orders = [makeOrder('o1', STORE, 1000, '2026-07-10T10:00:00.000Z', [], 200)]; // 200 discount → net 800
    const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day', 10);
    expect(s.totalRevenue).toBe(800);
    expect(s.platformCommission).toBe(80);
    expect(s.netProfit).toBe(720);
  });

  it('defaults to zero commission when no rate is passed (backward compatible)', () => {
    const orders = [makeOrder('o1', STORE, 1000, '2026-07-10T10:00:00.000Z')];
    const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day');
    expect(s.platformCommission).toBe(0);
    expect(s.netProfit).toBe(1000);
  });

  it('handles a fractional-percent commission without rounding drift beyond agora precision', () => {
    const orders = [makeOrder('o1', STORE, 333.33, '2026-07-10T10:00:00.000Z')];
    const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day', 15);
    // 15% of 333.33 = 49.9995 → rounded to 50.00
    expect(s.platformCommission).toBe(50);
    expect(s.netProfit).toBe(s.totalRevenue - s.platformCommission);
  });
});

describe('buildPerformanceSummary — unique visitors vs total visits', () => {
  const VIS = 'vis-store';

  it('sums total visits but de-dupes unique visitors across the range', () => {
    VISIT_FIXTURE[VIS] = [
      { date: '2026-07-10', views: 5, visitors: ['a', 'b'] },
      { date: '2026-07-11', views: 3, visitors: ['a', 'c'] }, // 'a' returns the next day
    ];
    const s = buildPerformanceSummary([], VIS, '2026-07-01', '2026-07-31', 'day');
    expect(s.totalViews).toBe(8);           // 5 + 3
    expect(s.totalUniqueVisitors).toBe(3);  // a, b, c — 'a' counted once
    const p10 = s.points.find((p) => p.key === '2026-07-10')!;
    expect(p10.views).toBe(5);
    expect(p10.uniqueVisitors).toBe(2);
  });

  it('unions unique visitors within a monthly bucket (not summed per day)', () => {
    VISIT_FIXTURE[VIS] = [
      { date: '2026-05-02', views: 4, visitors: ['a', 'b'] },
      { date: '2026-05-20', views: 4, visitors: ['a', 'b'] }, // same two people, same month
      { date: '2026-06-03', views: 4, visitors: ['a', 'd'] },
    ];
    const s = buildPerformanceSummary([], VIS, '2026-05-01', '2026-07-31', 'month');
    const may = s.points.find((p) => p.key === '2026-05')!;
    const jun = s.points.find((p) => p.key === '2026-06')!;
    expect(may.uniqueVisitors).toBe(2); // a, b — not 4
    expect(jun.uniqueVisitors).toBe(2); // a, d
    expect(s.totalUniqueVisitors).toBe(3); // a, b, d across the whole range
  });

  it('conversion falls back to total views when no visitor ids exist (legacy/demo rows)', () => {
    VISIT_FIXTURE[VIS] = [{ date: '2026-07-10', views: 100, visitors: [] }];
    const orders = [makeOrder('o1', VIS, 500, '2026-07-10T10:00:00.000Z')];
    const s = buildPerformanceSummary(orders, VIS, '2026-07-01', '2026-07-31', 'day');
    expect(s.totalUniqueVisitors).toBe(0);
    expect(s.conversionRate).toBeCloseTo(1); // 1 order / 100 views * 100
  });
});

describe('buildProductPerformance — single-product drill-down', () => {
  const item = (productId: string, price: number, qty: number) =>
    ({ productId, productName: 'P', productSlug: productId, storeSlug: STORE, storeName: 'S', price, qty, image: '' });

  it('sums units + gross revenue for the product across paid orders in range, and pulls its views', () => {
    PRODUCT_VIEW_FIXTURE['pA'] = [
      { date: '2026-07-10', views: 30 },
      { date: '2026-07-12', views: 20 },
    ];
    const orders = [
      makeOrder('o1', STORE, 100, '2026-07-10T10:00:00.000Z', [item('pA', 25, 2), item('pB', 50, 1)]),
      makeOrder('o2', STORE, 25, '2026-07-12T10:00:00.000Z', [item('pA', 25, 1)]),
    ];
    const ps = buildProductPerformance(orders, STORE, 'pA', '2026-07-01', '2026-07-31', 'day');
    expect(ps.totalUnits).toBe(3);         // 2 + 1
    expect(ps.totalRevenue).toBe(75);      // 25*2 + 25*1
    expect(ps.totalViews).toBe(50);        // 30 + 20
    expect(ps.ordersWithProduct).toBe(2);
    expect(ps.conversionRate).toBeCloseTo((2 / 50) * 100, 5);
  });

  it('ignores other products, other stores, and unpaid orders', () => {
    PRODUCT_VIEW_FIXTURE['pA'] = [{ date: '2026-07-10', views: 10 }];
    const paidOther = makeOrder('o1', STORE, 50, '2026-07-10T10:00:00.000Z', [item('pB', 50, 1)]);
    const unpaid = { ...makeOrder('o2', STORE, 25, '2026-07-10T10:00:00.000Z', [item('pA', 25, 1)]), paymentStatus: 'pending' as const };
    const ps = buildProductPerformance([paidOther, unpaid], STORE, 'pA', '2026-07-01', '2026-07-31', 'day');
    expect(ps.totalUnits).toBe(0);
    expect(ps.totalRevenue).toBe(0);
    expect(ps.ordersWithProduct).toBe(0);
    expect(ps.totalViews).toBe(10);
    expect(ps.conversionRate).toBe(0); // no orders → 0 despite views
  });

  it('counts an order containing the product once even if it appears in multiple line items', () => {
    PRODUCT_VIEW_FIXTURE['pA'] = [];
    const orders = [makeOrder('o1', STORE, 75, '2026-07-10T10:00:00.000Z', [item('pA', 25, 1), item('pA', 25, 2)])];
    const ps = buildProductPerformance(orders, STORE, 'pA', '2026-07-01', '2026-07-31', 'day');
    expect(ps.totalUnits).toBe(3);
    expect(ps.ordersWithProduct).toBe(1);
    expect(ps.conversionRate).toBe(0); // no views → 0, never divide-by-zero
  });
});
