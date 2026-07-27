import { describe, it, expect } from 'vitest';
import { buildPlatformPerformance, TOP_STORES_LIMIT } from '../src/lib/platform-performance.js';
import type { Order } from '../src/lib/orders.js';

// A minimal paid order touching one or more stores. Only the fields
// buildPerformanceSummary reads are populated. Page views are read from the
// real store-pageviews.json inside the summary builder; these fake slugs have
// no bucket there, so views are 0 throughout — the assertions below focus on
// the money aggregation, which is derived purely from `orders`.
function makeOrder(
  id: string,
  subtotals: Record<string, number>,
  createdAt: string,
  items: Order['items'] = [],
  status: Order['paymentStatus'] = 'paid',
): Order {
  const storeSubtotals: Order['storeSubtotals'] = {};
  for (const [slug, subtotal] of Object.entries(subtotals)) {
    storeSubtotals[slug] = { storeName: slug, subtotal, shipping: 0 };
  }
  const totalAmount = Object.values(subtotals).reduce((s, v) => s + v, 0);
  return {
    id,
    buyerName: 'x', buyerEmail: 'x@x.co', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    items,
    storeSubtotals,
    shippingAmount: 0,
    totalAmount,
    paymentStatus: status,
    shippingStatus: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}

// Commission is now per-store (it comes from each store's SELLER tier), so the fixture carries
// it explicitly instead of one platform-wide rate being passed at the call site.
const STORES = [
  { slug: 'alpha', name: 'Alpha', commissionPercent: 10 },
  { slug: 'beta', name: 'Beta', commissionPercent: 10 },
  { slug: 'gamma', name: 'Gamma', commissionPercent: 10 },
];
const FROM = '2026-07-01';
const TO = '2026-07-31';

describe('buildPlatformPerformance — aggregation across stores', () => {
  it('sums revenue and orders across every store', () => {
    const orders = [
      makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { beta: 500 }, '2026-07-06T10:00:00.000Z'),
      makeOrder('o3', { alpha: 250 }, '2026-07-07T10:00:00.000Z'),
    ];
    const p = buildPlatformPerformance(orders, STORES, FROM, TO, 'day');
    expect(p.summary.totalRevenue).toBe(1750);
    expect(p.summary.totalOrders).toBe(3);
    // commission (platform income) + payout (to sellers) reconcile to GMV
    expect(p.summary.platformCommission).toBe(175);
    expect(p.summary.netProfit).toBe(1575);
    expect(p.summary.platformCommission + p.summary.netProfit).toBe(p.summary.totalRevenue);
  });

  it('counts a multi-store order toward each store it touched', () => {
    const orders = [makeOrder('o1', { alpha: 300, beta: 200 }, '2026-07-05T10:00:00.000Z')];
    const p = buildPlatformPerformance(orders, STORES, FROM, TO, 'day');
    // orders sum reconciles with the breakdown rows (alpha:1 + beta:1)
    expect(p.summary.totalOrders).toBe(2);
    const alpha = p.stores.find((s) => s.slug === 'alpha');
    const beta = p.stores.find((s) => s.slug === 'beta');
    expect(alpha?.revenue).toBe(300);
    expect(beta?.revenue).toBe(200);
    expect(p.stores.reduce((s, r) => s + r.orders, 0)).toBe(p.summary.totalOrders);
  });

  it('ignores unpaid orders (same rule as the seller summary)', () => {
    const orders = [
      makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { alpha: 999 }, '2026-07-06T10:00:00.000Z', [], 'pending'),
    ];
    const p = buildPlatformPerformance(orders, STORES, FROM, TO, 'day');
    expect(p.summary.totalRevenue).toBe(1000);
    expect(p.summary.totalOrders).toBe(1);
  });

  it('builds a revenue-desc breakdown and only lists stores active in range', () => {
    const orders = [
      makeOrder('o1', { beta: 900 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { alpha: 100 }, '2026-07-06T10:00:00.000Z'),
      // gamma has no orders → excluded from the breakdown
    ];
    const p = buildPlatformPerformance(orders, STORES, FROM, TO, 'day');
    expect(p.stores.map((s) => s.slug)).toEqual(['beta', 'alpha']);
    expect(p.totalStores).toBe(2);
    expect(p.stores.some((s) => s.slug === 'gamma')).toBe(false);
  });

  it('aggregates platform top products across stores and honours topLimit', () => {
    const items = (slug: string, productId: string, name: string, price: number, qty: number): Order['items'] =>
      [{ productId, productName: name, productSlug: productId, storeSlug: slug, storeName: slug, price, qty }];
    const orders = [
      makeOrder('o1', { alpha: 200 }, '2026-07-05T10:00:00.000Z', items('alpha', 'p1', 'Widget', 100, 2)),
      makeOrder('o2', { beta: 300 }, '2026-07-06T10:00:00.000Z', items('beta', 'p2', 'Gadget', 300, 1)),
      makeOrder('o3', { alpha: 100 }, '2026-07-07T10:00:00.000Z', items('alpha', 'p1', 'Widget', 100, 1)),
    ];
    const p = buildPlatformPerformance(orders, STORES, FROM, TO, 'day', 5);
    const p1 = p.summary.topProducts.find((t) => t.productId === 'p1');
    expect(p1?.units).toBe(3);       // 2 + 1 across two orders
    expect(p1?.revenue).toBe(300);   // 100 * 3
    // revenue-desc: gadget (300) ties widget (300) — both present, capped by topLimit
    expect(p.summary.topProducts.length).toBe(2);

    const capped = buildPlatformPerformance(orders, STORES, FROM, TO, 'day', 1);
    expect(capped.summary.topProducts.length).toBe(1);
  });

  it('zero-fills the point axis for an empty platform', () => {
    const p = buildPlatformPerformance([], STORES, FROM, TO, 'day');
    expect(p.summary.totalRevenue).toBe(0);
    expect(p.summary.points.length).toBe(31); // full July, zero-filled
    expect(p.summary.points.every((pt) => pt.revenue === 0 && pt.orders === 0)).toBe(true);
    expect(p.stores.length).toBe(0);
  });

  it('caps the breakdown at storeLimit while still counting the total', () => {
    const many = Array.from({ length: TOP_STORES_LIMIT + 5 }, (_, i) => ({ slug: `s${i}`, name: `S${i}` }));
    const orders = many.map((s, i) => makeOrder(`o${i}`, { [s.slug]: (i + 1) * 10 }, '2026-07-05T10:00:00.000Z'));
    const p = buildPlatformPerformance(orders, many, FROM, TO, 'day', 5, TOP_STORES_LIMIT);
    expect(p.stores.length).toBe(TOP_STORES_LIMIT);
    expect(p.totalStores).toBe(TOP_STORES_LIMIT + 5);
    expect(p.shownStores).toBe(TOP_STORES_LIMIT);
    // highest-revenue store leads the capped list
    expect(p.stores[0].revenue).toBeGreaterThanOrEqual(p.stores[1].revenue);
  });
});

describe('mixed-tier commission', () => {
  it('applies each store its own rate and reports the blended actual, not one tier', () => {
    const mixed = [
      { slug: 'alpha', name: 'Alpha', commissionPercent: 12 }, // starter
      { slug: 'beta', name: 'Beta', commissionPercent: 4 },    // enterprise
    ];
    const orders = [
      makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { beta: 1000 }, '2026-07-06T10:00:00.000Z'),
    ];
    const p = buildPlatformPerformance(orders, mixed, FROM, TO, 'day');
    expect(p.summary.totalRevenue).toBe(2000);
    expect(p.summary.platformCommission).toBe(160); // 120 + 40, NOT 2000 * one rate
    expect(p.summary.commissionRate).toBe(8);       // revenue-weighted blend
    expect(p.summary.platformCommission + p.summary.netProfit).toBe(p.summary.totalRevenue);
  });

  it('takes no commission from a store whose rate is absent', () => {
    const p = buildPlatformPerformance(
      [makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z')],
      [{ slug: 'alpha', name: 'Alpha' }],
      FROM, TO, 'day',
    );
    expect(p.summary.platformCommission).toBe(0);
    expect(p.summary.commissionRate).toBe(0);
  });
});
