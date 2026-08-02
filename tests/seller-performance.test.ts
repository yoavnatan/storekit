import { describe, it, expect } from 'vitest';
import type { Order } from '../src/lib/orders.js';
import { buildPerformanceSummary, buildProductPerformance } from '../src/lib/seller-performance.js';
import { EMPTY_VIEW_STATS, type StoreViewStats, type ViewBucket } from '../src/lib/store-pageviews.js';
import { EMPTY_PRODUCT_VIEW_STATS, type ProductViewStats } from '../src/lib/product-pageviews.js';

// Page views are an INPUT to both builders now, not something they read off disk, so these tests
// hand them over directly — no module mock, and nothing here can pass because a mock agreed with
// itself. What the DATABASE does with the same data (bucketing, DISTINCT per bucket vs across the
// range) is proven against a real Postgres in tests/store-pageviews-db.test.ts.

/** Store view stats from bucket rows, with the range total stated separately — because it is: a
 *  visitor who returns in two buckets is one unique visitor for the range, never the sum. */
const viewStats = (buckets: ViewBucket[], totalUniqueVisitors: number): StoreViewStats => ({
  buckets,
  totalViews: buckets.reduce((sum, b) => sum + b.views, 0),
  totalUniqueVisitors,
});

const productViews = (buckets: { key: string; views: number }[]): ProductViewStats => ({
  buckets,
  totalViews: buckets.reduce((sum, b) => sum + b.views, 0),
});

// Builds a minimal paid order for one store on a given date. Only the fields
// buildPerformanceSummary actually reads are populated.
function makeOrder(id: string, storeSlug: string, subtotalAgorot: number, createdAt: string, items: Order['items'] = [], discountApplied = 0): Order {
  return {
    id,
    buyerName: 'x', buyerEmail: 'x@x.co', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    items,
    storeSubtotals: { [storeSlug]: { storeName: 'S', subtotalAgorot, shippingAgorot: 0, ...(discountApplied ? { discount: { type: 'amount', value: discountApplied, appliedAgorot: discountApplied } } : {}) } },
    shippingAgorot: 0,
    totalAgorot: subtotalAgorot,
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
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day', 10);
    expect(s.totalRevenueAgorot).toBe(1500);
    expect(s.commissionRate).toBe(10);
    expect(s.platformCommissionAgorot).toBe(150); // 10% of 1500
    expect(s.netProfitAgorot).toBe(1350);
    // net + commission must reconcile back to gross exactly (no rounding drift)
    expect(s.netProfitAgorot + s.platformCommissionAgorot).toBe(s.totalRevenueAgorot);
  });

  it('commission is net of a seller discount (uses the same net basis as revenue)', () => {
    const orders = [makeOrder('o1', STORE, 1000, '2026-07-10T10:00:00.000Z', [], 200)]; // 200 discount → net 800
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day', 10);
    expect(s.totalRevenueAgorot).toBe(800);
    expect(s.platformCommissionAgorot).toBe(80);
    expect(s.netProfitAgorot).toBe(720);
  });

  it('defaults to zero commission when no rate is passed (backward compatible)', () => {
    const orders = [makeOrder('o1', STORE, 1000, '2026-07-10T10:00:00.000Z')];
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day');
    expect(s.platformCommissionAgorot).toBe(0);
    expect(s.netProfitAgorot).toBe(1000);
  });

  it('handles a fractional-percent commission without rounding drift beyond agora precision', () => {
    const orders = [makeOrder('o1', STORE, 333.33, '2026-07-10T10:00:00.000Z')];
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day', 15);
    // 15% of 333.33 = 49.9995 → rounded to 50.00
    expect(s.platformCommissionAgorot).toBe(50);
    expect(s.netProfitAgorot).toBe(s.totalRevenueAgorot - s.platformCommissionAgorot);
  });
});

describe('buildPerformanceSummary — unique visitors vs total visits', () => {
  const VIS = 'vis-store';

  it('places each bucket on the axis and reports the range total it was given', () => {
    // Two days, three people, 'a' present on both — so the range total (3) is deliberately LESS
    // than the sum of the buckets (4). Anything here that re-derived the total from the buckets
    // would report 4.
    const s = buildPerformanceSummary([], viewStats([
      { key: '2026-07-10', views: 5, uniqueVisitors: 2 },
      { key: '2026-07-11', views: 3, uniqueVisitors: 2 },
    ], 3), VIS, '2026-07-01', '2026-07-31', 'day');
    expect(s.totalViews).toBe(8);           // 5 + 3
    expect(s.totalUniqueVisitors).toBe(3);  // 'a' counted once, NOT 2 + 2
    const p10 = s.points.find((p) => p.key === '2026-07-10')!;
    expect(p10.views).toBe(5);
    expect(p10.uniqueVisitors).toBe(2);
  });

  it('keeps a monthly bucket on the month axis and zero-fills the months with no traffic', () => {
    const s = buildPerformanceSummary([], viewStats([
      { key: '2026-05', views: 8, uniqueVisitors: 2 },
      { key: '2026-06', views: 4, uniqueVisitors: 2 },
    ], 3), VIS, '2026-05-01', '2026-07-31', 'month');
    expect(s.points.find((p) => p.key === '2026-05')!.uniqueVisitors).toBe(2);
    expect(s.points.find((p) => p.key === '2026-06')!.uniqueVisitors).toBe(2);
    expect(s.points.find((p) => p.key === '2026-07')!.views).toBe(0); // no traffic ≠ a gap
    expect(s.totalUniqueVisitors).toBe(3);
  });

  it('conversion falls back to total views when no visitor ids exist (legacy/demo rows)', () => {
    const orders = [makeOrder('o1', VIS, 500, '2026-07-10T10:00:00.000Z')];
    const s = buildPerformanceSummary(orders, viewStats([{ key: '2026-07-10', views: 100, uniqueVisitors: 0 }], 0),
      VIS, '2026-07-01', '2026-07-31', 'day');
    expect(s.totalUniqueVisitors).toBe(0);
    expect(s.conversionRate).toBeCloseTo(1); // 1 order / 100 views * 100
  });
});

describe('buildProductPerformance — single-product drill-down', () => {
  const item = (productId: string, priceAgorot: number, qty: number) =>
    ({ productId, productName: 'P', productSlug: productId, storeSlug: STORE, storeName: 'S', priceAgorot, qty, image: '' });

  it('sums units + gross revenue for the product across paid orders in range, and pulls its views', () => {
    const orders = [
      makeOrder('o1', STORE, 100, '2026-07-10T10:00:00.000Z', [item('pA', 25, 2), item('pB', 50, 1)]),
      makeOrder('o2', STORE, 25, '2026-07-12T10:00:00.000Z', [item('pA', 25, 1)]),
    ];
    const ps = buildProductPerformance(orders, productViews([
      { key: '2026-07-10', views: 30 },
      { key: '2026-07-12', views: 20 },
    ]), STORE, 'pA', '2026-07-01', '2026-07-31', 'day');
    expect(ps.totalUnits).toBe(3);         // 2 + 1
    expect(ps.totalRevenueAgorot).toBe(75);      // 25*2 + 25*1
    expect(ps.totalViews).toBe(50);        // 30 + 20
    expect(ps.ordersWithProduct).toBe(2);
    expect(ps.conversionRate).toBeCloseTo((2 / 50) * 100, 5);
  });

  it('ignores other products, other stores, and unpaid orders', () => {
    const paidOther = makeOrder('o1', STORE, 50, '2026-07-10T10:00:00.000Z', [item('pB', 50, 1)]);
    const unpaid = { ...makeOrder('o2', STORE, 25, '2026-07-10T10:00:00.000Z', [item('pA', 25, 1)]), paymentStatus: 'pending' as const };
    const ps = buildProductPerformance([paidOther, unpaid], productViews([{ key: '2026-07-10', views: 10 }]), STORE, 'pA', '2026-07-01', '2026-07-31', 'day');
    expect(ps.totalUnits).toBe(0);
    expect(ps.totalRevenueAgorot).toBe(0);
    expect(ps.ordersWithProduct).toBe(0);
    expect(ps.totalViews).toBe(10);
    expect(ps.conversionRate).toBe(0); // no orders → 0 despite views
  });

  it('counts an order containing the product once even if it appears in multiple line items', () => {
    const orders = [makeOrder('o1', STORE, 75, '2026-07-10T10:00:00.000Z', [item('pA', 25, 1), item('pA', 25, 2)])];
    const ps = buildProductPerformance(orders, EMPTY_PRODUCT_VIEW_STATS, STORE, 'pA', '2026-07-01', '2026-07-31', 'day');
    expect(ps.totalUnits).toBe(3);
    expect(ps.ordersWithProduct).toBe(1);
    expect(ps.conversionRate).toBe(0); // no views → 0, never divide-by-zero
  });
});
