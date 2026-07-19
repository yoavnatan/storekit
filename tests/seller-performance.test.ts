import { describe, it, expect } from 'vitest';
import { buildPerformanceSummary } from '../src/lib/seller-performance.js';
import type { Order } from '../src/lib/orders.js';

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
