import { describe, expect, it } from 'vitest';
import { buildBuyerOrderConfirmation, buildSellerOrderNotification } from '../src/lib/email/order-emails.js';
import type { Order, OrderItem } from '../src/lib/orders.js';

function item(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    productId: 'p1', productName: 'חולצה', productSlug: 'shirt',
    storeSlug: 'store-a', storeName: 'חנות א', priceAgorot: 100, qty: 1,
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    checkoutRef: 'ABC123',
    buyerName: 'דנה כהן', buyerEmail: 'dana@example.com', buyerPhone: '0501234567',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1', zip: '6100000' },
    items: [item()],
    storeSubtotals: { 'store-a': { storeName: 'חנות א', subtotalAgorot: 100, shippingAgorot: 20 } },
    shippingAgorot: 20,
    totalAgorot: 120,
    paymentStatus: 'paid',
    shippingStatus: 'pending',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildBuyerOrderConfirmation', () => {
  it('addresses the email to the buyer and carries the checkout ref', () => {
    const msg = buildBuyerOrderConfirmation([order()]);
    expect(msg.to).toBe('dana@example.com');
    expect(msg.subject).toContain('ABC123');
    expect(msg.html).toContain('דנה כהן');
    expect(msg.text).toContain('ABC123');
  });

  it('sums a multi-store checkout into one grand total', () => {
    // Amounts are agorot (orders.ts); the email renders ILS. Whole-shekel figures on purpose, so
    // the assertion is on the SUM rather than on how many decimals the formatter chose to print.
    const a = order({ id: 'o1', totalAgorot: 12_000, shippingAgorot: 2_000, items: [item({ priceAgorot: 10_000, qty: 1 })] });
    const b = order({
      id: 'o2', totalAgorot: 25_000, shippingAgorot: 0,
      items: [item({ productName: 'נעליים', storeName: 'חנות ב', storeSlug: 'store-b', priceAgorot: 25_000, qty: 1 })],
    });
    const msg = buildBuyerOrderConfirmation([a, b]);
    // grand total 120 ₪ + 250 ₪ = 370 ₪
    expect(msg.html).toContain('370');
    expect(msg.html).toContain('חנות ב');
    expect(msg.text).toContain('נעליים');
  });

  it('escapes HTML in buyer-supplied fields (no injection into the email body)', () => {
    const msg = buildBuyerOrderConfirmation([order({ buyerName: '<script>x</script>' })]);
    expect(msg.html).not.toContain('<script>x</script>');
    expect(msg.html).toContain('&lt;script&gt;');
  });

  it('renders selected variants under the item', () => {
    const msg = buildBuyerOrderConfirmation([order({ items: [item({ selectedVariants: { מידה: 'L', צבע: 'שחור' } })] })]);
    expect(msg.html).toContain('מידה: L');
  });
});

describe('buildSellerOrderNotification', () => {
  it('goes to the seller with the fulfilment details', () => {
    const msg = buildSellerOrderNotification(order(), 'seller@example.com');
    expect(msg.to).toBe('seller@example.com');
    expect(msg.html).toContain('דנה כהן');       // buyer name for fulfilment
    expect(msg.html).toContain('הרצל 1');         // shipping address
    expect(msg.subject).toContain('ABC123');
  });
});
