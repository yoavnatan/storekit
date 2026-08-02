import { describe, expect, it } from 'vitest';
import { buildOrderStatusNotification } from '../src/lib/order-notify.js';
import type { Order } from '../src/lib/orders.js';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    buyerId: 'buyer-1',
    buyerName: 'A', buyerEmail: 'a@b.c', buyerPhone: '0500000000',
    buyerAddress: { city: 'TLV', street: 'Main 1' },
    items: [],
    storeSubtotals: {},
    shippingAgorot: 0,
    totalAgorot: 0,
    paymentStatus: 'paid',
    shippingStatus: 'shipped',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildOrderStatusNotification', () => {
  it('builds a buyer notification for a real status change', () => {
    const n = buildOrderStatusNotification(order({ shippingStatus: 'shipped' }), 'processing');
    expect(n).not.toBeNull();
    expect(n!.userId).toBe('buyer-1');
    expect(n!.role).toBe('buyer');
    expect(n!.type).toBe('order_update');
    expect(n!.relatedId).toBe('o1');
  });

  it('includes the tracking number in the shipped message when present', () => {
    const n = buildOrderStatusNotification(order({ shippingStatus: 'shipped', trackingNumber: 'IL123' }), 'ready');
    expect(n!.body).toContain('IL123');
  });

  it('returns null when the status did not actually change', () => {
    expect(buildOrderStatusNotification(order({ shippingStatus: 'shipped' }), 'shipped')).toBeNull();
  });

  it('returns null for a guest buyer (no account to notify — email will cover it)', () => {
    expect(buildOrderStatusNotification(order({ shippingStatus: 'shipped', buyerId: undefined }), 'processing')).toBeNull();
  });

  it('returns null for a status with no buyer-facing message (e.g. back to pending)', () => {
    expect(buildOrderStatusNotification(order({ shippingStatus: 'pending' }), 'processing')).toBeNull();
  });

  it('announces a cancellation', () => {
    const n = buildOrderStatusNotification(order({ shippingStatus: 'cancelled' }), 'processing');
    expect(n).not.toBeNull();
    expect(n!.title).toContain('בוטלה');
  });
});
