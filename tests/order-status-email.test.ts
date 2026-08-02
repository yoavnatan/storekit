import { describe, expect, it } from 'vitest';
import { buildOrderStatusEmail } from '../src/lib/email/order-status-email.js';
import type { Order } from '../src/lib/orders.js';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1', checkoutRef: 'REF123',
    buyerName: 'דנה כהן', buyerEmail: 'dana@example.com', buyerPhone: '0501234567',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ productId: 'p1', productName: 'חולצה', productSlug: 'shirt', storeSlug: 'urban', storeName: 'Urban Threads', priceAgorot: 100, qty: 1 }],
    storeSubtotals: { urban: { storeName: 'Urban Threads', subtotalAgorot: 100, shippingAgorot: 0 } },
    shippingAgorot: 0, totalAgorot: 100,
    paymentStatus: 'paid', shippingStatus: 'shipped',
    createdAt: '2026-07-24T00:00:00.000Z', updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildOrderStatusEmail', () => {
  it('builds a shipped email addressed to the buyer, incl. the tracking number', () => {
    const msg = buildOrderStatusEmail(order({ shippingStatus: 'shipped', trackingNumber: 'IL999' }), 'shipped');
    expect(msg).not.toBeNull();
    expect(msg!.to).toBe('dana@example.com');
    expect(msg!.subject).toContain('נשלחה');
    expect(msg!.subject).toContain('REF123');
    expect(msg!.html).toContain('IL999');       // tracking number surfaced
    expect(msg!.html).toContain('Urban Threads'); // store named
  });

  it('builds a ready email', () => {
    const msg = buildOrderStatusEmail(order({ shippingStatus: 'ready' }), 'ready');
    expect(msg!.subject).toContain('מוכנה');
    expect(msg!.html).toContain('לצפייה בחנות'); // CTA present for ready
  });

  it('builds a cancellation email with the refund note and no store CTA', () => {
    const msg = buildOrderStatusEmail(order({ shippingStatus: 'cancelled' }), 'cancelled');
    expect(msg!.subject).toContain('בוטלה');
    expect(msg!.html).toContain('החזר כספי');
    expect(msg!.html).not.toContain('לצפייה בחנות'); // no shopping CTA on a cancellation
  });

  it('reaches GUEST buyers too (no buyerId required — unlike the in-app notification)', () => {
    const msg = buildOrderStatusEmail(order({ buyerId: undefined, shippingStatus: 'shipped' }), 'shipped');
    expect(msg).not.toBeNull();
    expect(msg!.to).toBe('dana@example.com');
  });

  it('returns null for a status with no buyer-facing message (processing / delivered / pending)', () => {
    expect(buildOrderStatusEmail(order({ shippingStatus: 'processing' }), 'processing')).toBeNull();
    expect(buildOrderStatusEmail(order({ shippingStatus: 'delivered' }), 'delivered')).toBeNull();
    expect(buildOrderStatusEmail(order({ shippingStatus: 'pending' }), 'pending')).toBeNull();
  });

  it('escapes buyer-supplied fields (no HTML injection)', () => {
    const msg = buildOrderStatusEmail(order({ buyerName: '<b>x</b>', shippingStatus: 'ready' }), 'ready');
    expect(msg!.html).not.toContain('<b>x</b>');
    expect(msg!.html).toContain('&lt;b&gt;');
  });
});
