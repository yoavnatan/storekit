import { describe, expect, it } from 'vitest';
import { buildInvoiceReadyEmail } from '../src/lib/email/invoice-email.js';
import type { Order } from '../src/lib/orders.js';

/**
 * The "your invoice is ready" mail.
 *
 * The two assertions that matter are the two decisions the feature is built on, and both are
 * invisible from the rendered output alone: the document travels as a LINK (an attached PDF costs
 * deliverability, and the file already lives on Cloudinary), and the mail says out loud that the
 * document is the SELLER's — the platform does not issue the buyer's tax invoice, it only shows it.
 */

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1', checkoutRef: 'REF9',
    buyerName: 'דנה כהן', buyerEmail: 'dana@example.com', buyerPhone: '0501234567',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ productId: 'p1', productName: 'חולצה', productSlug: 'shirt', storeSlug: 'urban', storeName: 'Urban Threads', priceAgorot: 100, qty: 1 }],
    storeSubtotals: { urban: { storeName: 'Urban Threads', subtotalAgorot: 100, shippingAgorot: 0 } },
    shippingAgorot: 0, totalAgorot: 100,
    paymentStatus: 'paid', shippingStatus: 'delivered',
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

const DOC = 'https://res.cloudinary.com/x/image/upload/v1/invoice.pdf';

describe('buildInvoiceReadyEmail', () => {
  it('links the document and names the store that issued it', () => {
    const msg = buildInvoiceReadyEmail({ order: order(), documentUrl: DOC })!;
    expect(msg.to).toBe('dana@example.com');
    expect(msg.subject).toContain('Urban Threads');
    expect(msg.subject).toContain('REF9');
    expect(msg.html).toContain(DOC);
    expect(msg.text).toContain(DOC);
    // The invoice is the seller's, and the mail has to say where questions go.
    expect(msg.html).toContain('הופקה על ידי');
  });

  it('returns null when there is nothing to link to — the handover case reaching here by mistake', () => {
    expect(buildInvoiceReadyEmail({ order: order(), documentUrl: '' })).toBeNull();
  });

  it('returns null for an order with no buyer address', () => {
    expect(buildInvoiceReadyEmail({ order: order({ buyerEmail: '' }), documentUrl: DOC })).toBeNull();
  });

  it('escapes buyer-supplied fields', () => {
    const msg = buildInvoiceReadyEmail({ order: order({ buyerName: '<img src=x onerror=1>' }), documentUrl: DOC })!;
    expect(msg.html).not.toContain('<img src=x');
    expect(msg.html).toContain('&lt;img');
  });
});
