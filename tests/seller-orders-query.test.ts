import { describe, it, expect } from 'vitest';
import { filterAndSortSellerOrders, type SellerOrderQuery } from '../src/lib/seller-orders-query';
import type { Order } from '../src/lib/orders';

// Minimal Order factory — the urgency sort only reads shippingStatus + createdAt,
// but the type needs storeSubtotals present for the amount branch not under test.
function order(id: string, shippingStatus: string, createdAt: string): Order {
  return {
    id,
    shippingStatus,
    createdAt,
    storeSubtotals: { s: { subtotal: 0, shipping: 0 } },
    buyerName: '', buyerEmail: '', buyerPhone: '',
  } as unknown as Order;
}

const urgencyQuery: SellerOrderQuery = { q: '', sortCol: 'urgency', sortDir: 'asc', shippingStatus: [] };

describe('filterAndSortSellerOrders — urgency sort', () => {
  it('floats owe-action orders (pending/processing/ready) above shipped, then delivered last', () => {
    const orders = [
      order('delivered', 'delivered', '2026-07-20T10:00:00Z'),
      order('shipped', 'shipped', '2026-07-20T10:00:00Z'),
      order('pending', 'pending', '2026-07-20T10:00:00Z'),
      order('processing', 'processing', '2026-07-20T10:00:00Z'),
    ];
    const sorted = filterAndSortSellerOrders(orders, 's', urgencyQuery).map((o) => o.id);
    // Both owe-action orders come before shipped; delivered is last.
    expect(sorted.indexOf('pending')).toBeLessThan(sorted.indexOf('shipped'));
    expect(sorted.indexOf('processing')).toBeLessThan(sorted.indexOf('shipped'));
    expect(sorted.indexOf('shipped')).toBeLessThan(sorted.indexOf('delivered'));
    expect(sorted[sorted.length - 1]).toBe('delivered');
  });

  it('within the owe-action group, the oldest (most overdue) sorts to the top', () => {
    const orders = [
      order('fresh', 'pending', '2026-07-24T10:00:00Z'),
      order('old', 'processing', '2026-07-10T10:00:00Z'),
      order('mid', 'pending', '2026-07-18T10:00:00Z'),
    ];
    const sorted = filterAndSortSellerOrders(orders, 's', urgencyQuery).map((o) => o.id);
    expect(sorted).toEqual(['old', 'mid', 'fresh']);
  });

  it('only sorts what the status filter lets through (delivered absent unless filtered in)', () => {
    const orders = [
      order('delivered', 'delivered', '2026-07-20T10:00:00Z'),
      order('pending', 'pending', '2026-07-20T10:00:00Z'),
    ];
    const activeOnly: SellerOrderQuery = { ...urgencyQuery, shippingStatus: ['pending', 'processing', 'ready', 'shipped'] };
    const sorted = filterAndSortSellerOrders(orders, 's', activeOnly).map((o) => o.id);
    expect(sorted).toEqual(['pending']);
  });
});
