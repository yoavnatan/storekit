import { describe, it, expect } from 'vitest';
import { filterAndSortSellerOrders, parseSellerOrderQuery, ORDER_FILTER_STATUSES, type SellerOrderQuery } from '../src/lib/seller-orders-query';
import type { Order } from '../src/lib/orders';
import { readFileSync } from 'node:fs';

// Minimal Order factory — the urgency sort only reads shippingStatus + createdAt,
// but the type needs storeSubtotals present for the amount branch not under test.
function order(id: string, shippingStatus: string, createdAt: string): Order {
  return {
    id,
    shippingStatus,
    createdAt,
    storeSubtotals: { s: { subtotalAgorot: 0, shippingAgorot: 0 } },
    buyerName: '', buyerEmail: '', buyerPhone: '',
  } as unknown as Order;
}

const urgencyQuery: SellerOrderQuery = { q: '', sortCol: 'urgency', sortDir: 'asc', shippingStatus: [], payoutStatus: [] };

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

// A fresh Orders tab already renders a FILTERED list (the "active" preset), so the
// toolbar's filter badge has to say so on the very first paint. It used to be a
// hardcoded hidden "0" that only came alive when the client re-fetched after some
// other filter change — the seller saw "no filter" over a filtered list.
describe('seller dashboard — Orders filter badge is SSR-computed', () => {
  const dashboard = readFileSync(new URL('../src/pages/seller/dashboard.astro', import.meta.url), 'utf8');

  it('defaults to a non-empty status filter, i.e. one active filter column', () => {
    expect(parseSellerOrderQuery(new URLSearchParams()).shippingStatus.length).toBeGreaterThan(0);
  });

  it('an explicitly cleared ?ostatus= means no active filter column', () => {
    expect(parseSellerOrderQuery(new URLSearchParams('ostatus=')).shippingStatus).toEqual([]);
  });

  it('the default view only holds statuses the filter menu can express', () => {
    // Otherwise the SSR page shows a status (e.g. a future carrier-set 'ready') that the
    // client's first re-fetch drops, with no visible change in the filter.
    for (const s of parseSellerOrderQuery(new URLSearchParams()).shippingStatus) {
      expect(ORDER_FILTER_STATUSES).toContain(s);
    }
  });

  it('the client toolbar reads both lists from this module, never a second copy', () => {
    const client = readFileSync(new URL('../src/scripts/dashboard/orders.ts', import.meta.url), 'utf8');
    expect(client).toContain('ORDER_ACTIVE_STATUSES');
    expect(client).toContain('ORDER_FILTER_STATUSES');
    expect(client).not.toMatch(/const (ACTIVE_STATUSES|ORDER_STATUSES) = (new Set\(\[|\[)'/);
  });

  it('binds the badge to that count instead of a hardcoded hidden 0', () => {
    const badge = dashboard.split('\n').find((l) => l.includes('id="orders-filter-count"')) ?? '';
    expect(badge).toContain('hidden={ordersActiveFilterCount === 0}');
    expect(badge).toContain('{ordersActiveFilterCount}');
  });
});
