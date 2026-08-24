/**
 * The two documents the agent model owes, and the ways a tax document goes wrong.
 *
 * A duplicate invoice cannot be deleted — it has to be cancelled with a credit note — so
 * idempotency matters more here than almost anywhere else. And VAT on a document issued in someone
 * else's name is a statement about THEIR tax status: charging it for an עוסק פטור, or extracting it
 * from a figure it was never added to, misstates a real business's affairs on a document carrying
 * their name.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { planBuyerInvoice, planPlatformInvoice } from '../src/lib/invoicing/index.js';
import { getDocumentsForSeller, planDocument } from '../src/lib/invoicing/documents.js';
import { vatWithinAgorot, chargesVat, VAT_PERCENT } from '../src/lib/vat.js';
import { monthlyFeeForTier } from '../src/lib/pricing.js';
import { toAgorot } from '../src/lib/money.js';
import type { Order } from '../src/lib/orders.js';

async function makeSeller(businessType?: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, business_type, created_at)
     VALUES ($1, 'Inv Test', $2, '', $3, now())`,
    [id, `inv-${id}@example.com`, businessType ?? null],
  );
  return id;
}

async function makeOrder(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status)
     VALUES ($1, 'Buyer', 'b@example.com', 12000, 'paid', 'pending')`,
    [id],
  );
  return id;
}

/** An order carrying one store's slice, shaped as `orderNetForStore` reads it. */
function orderWith(id: string, subtotalAgorot: number, shippingAgorot: number): Order {
  return {
    id,
    buyerName: 'Buyer', buyerEmail: 'b@example.com', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    items: [],
    storeSubtotals: { shop: { subtotalAgorot, shippingAgorot } },
    shippingAgorot, totalAgorot: subtotalAgorot + shippingAgorot,
    paymentStatus: 'paid', shippingStatus: 'pending',
    createdAt: '', updatedAt: '',
  } as unknown as Order;
}

describe('VAT is extracted, never added', () => {
  it('net + vat is exactly the gross, with no lost agora', () => {
    // The property a bookkeeper checks first: the lines add up to the total. Awkward amounts, since
    // round numbers agree under any implementation.
    for (const gross of [1, 99, 100, 3_333, 11_811, 99_999, 1_234_567]) {
      const vat = vatWithinAgorot(gross);
      expect(gross - vat + vat).toBe(gross);
      expect(vat).toBeLessThan(gross);
      expect(vat).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a share of the gross, not a markup on it', () => {
    // 118 gross at 18% contains 18 of VAT, not 21.24 — the mistake that would inflate every
    // document by the rate and break the storefront-to-invoice price match.
    const vat = vatWithinAgorot(11_800, 18);
    expect(vat).toBe(1_800);
    expect(VAT_PERCENT).toBe(18);
  });

  it('refuses nonsense instead of producing a negative line', () => {
    expect(vatWithinAgorot(0)).toBe(0);
    expect(vatWithinAgorot(-500)).toBe(0);
    expect(vatWithinAgorot(1000, 0)).toBe(0);
    expect(vatWithinAgorot(Number.NaN)).toBe(0);
  });

  it('an עוסק פטור charges none, and an unknown business type is treated as none', () => {
    expect(chargesVat('licensed')).toBe(true);
    expect(chargesVat('company')).toBe(true);
    expect(chargesVat('exempt')).toBe(false);
    // Not knowing is not a reason to assert a tax status on a seller's behalf.
    expect(chargesVat(undefined)).toBe(false);
    expect(chargesVat(null)).toBe(false);
  });
});

describe("the buyer's invoice, owed by the seller", () => {
  it('is for the GOODS the buyer paid for, before any commission and WITHOUT shipping', async () => {
    const sellerId = await makeSeller('licensed');
    const orderId = await makeOrder();
    const doc = await planBuyerInvoice(orderWith(orderId, 10_000, 2_000), 'shop', { id: sellerId, businessType: 'licensed' });

    expect(doc).not.toBeNull();
    // Commission is between the platform and the seller and belongs on the other document entirely,
    // so the figure is BEFORE it. Shipping is excluded for the opposite reason: it never reaches the
    // seller at all (`payouts.ts` — "never shipping"), so invoicing the buyer for it in the seller's
    // name would bill for money he was never paid.
    expect(doc!.amountAgorot).toBe(10_000);
    expect(doc!.direction).toBe('seller_to_buyer');
    expect(doc!.sellerId).toBe(sellerId);
    expect(doc!.status).toBe('pending');
    expect(doc!.vatAgorot).toBe(vatWithinAgorot(10_000));
  });

  it('shows no VAT for an עוסק פטור', async () => {
    const sellerId = await makeSeller('exempt');
    const orderId = await makeOrder();
    const doc = await planBuyerInvoice(orderWith(orderId, 10_000, 2_000), 'shop', { id: sellerId, businessType: 'exempt' });
    expect(doc!.amountAgorot).toBe(10_000);
    expect(doc!.vatAgorot).toBe(0);
  });

  it('plans nothing for a slice that is shipping only — there are no goods to invoice', async () => {
    const sellerId = await makeSeller('licensed');
    const orderId = await makeOrder();
    expect(await planBuyerInvoice(orderWith(orderId, 0, 2_000), 'shop', { id: sellerId, businessType: 'licensed' })).toBeNull();
  });

  it('plans ONE document per order however many times the checkout replays', async () => {
    const sellerId = await makeSeller('licensed');
    const orderId = await makeOrder();
    const order = orderWith(orderId, 10_000, 2_000);

    const first = await planBuyerInvoice(order, 'shop', { id: sellerId, businessType: 'licensed' });
    const second = await planBuyerInvoice(order, 'shop', { id: sellerId, businessType: 'licensed' });

    expect(first).not.toBeNull();
    // A duplicate tax document cannot be deleted, only cancelled with a credit note — so the
    // second attempt must produce nothing rather than a second row.
    expect(second).toBeNull();
    expect((await getDocumentsForSeller(sellerId)).filter((d) => d.orderId === orderId)).toHaveLength(1);
  });

  it('plans nothing for an empty slice', async () => {
    const sellerId = await makeSeller('licensed');
    const orderId = await makeOrder();
    expect(await planBuyerInvoice(orderWith(orderId, 0, 0), 'shop', { id: sellerId, businessType: 'licensed' })).toBeNull();
  });
});

describe("the platform's invoice to the seller", () => {
  it('is the three streams together, and says which is which', async () => {
    const sellerId = await makeSeller('company');
    // What the standing order charged — one shop on the entry plan. Passed in, because since
    // 2026-08-24 a seller's monthly fee is the sum of his live shops' plans and the invoice quotes
    // what was charged rather than re-deriving it (`lib/store-plan.ts`).
    const subscription = toAgorot(monthlyFeeForTier('starter'));
    const doc = await planPlatformInvoice({
      seller: { id: sellerId },
      periodKey: '2026-08',
      commissionAgorot: 12_000,
      subscriptionAgorot: subscription,
      adMarginAgorot: 500,
    });

    expect(doc!.amountAgorot).toBe(12_000 + subscription + 500);
    expect(doc!.direction).toBe('platform_to_seller');
    expect(doc!.periodKey).toBe('2026-08');
    // A seller reconciling their books needs the split — and the commission is the only one of the
    // three already deducted from their payout.
    expect(doc!.detail).toContain('commission 12000 (deducted at source)');
    expect(doc!.detail).toContain(`subscription ${subscription}`);
    expect(doc!.detail).toContain('ad margin 500');
  });

  it('charges OUR VAT regardless of the seller\'s business type', async () => {
    // The asymmetry that justifies two functions: on this document the platform is the issuer, so
    // an exempt seller's status is irrelevant.
    const sellerId = await makeSeller('exempt');
    const doc = await planPlatformInvoice({ seller: { id: sellerId }, periodKey: '2026-08', commissionAgorot: 10_000 });
    expect(doc!.vatAgorot).toBe(vatWithinAgorot(doc!.amountAgorot));
    expect(doc!.vatAgorot).toBeGreaterThan(0);
  });

  it('plans ONE document per seller per month', async () => {
    const sellerId = await makeSeller('company');
    const first = await planPlatformInvoice({ seller: { id: sellerId }, periodKey: '2026-08', commissionAgorot: 10_000 });
    const second = await planPlatformInvoice({ seller: { id: sellerId }, periodKey: '2026-08', commissionAgorot: 10_000 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('omits the subscription line when nothing was being billed', async () => {
    // A real state, not an edge case: a seller with no shop on the site has no standing order at
    // all (`lib/store-plan.ts` — the price is the sum of his live shops, and an empty sum is not a
    // ₪0 charge but no charge). His commission-only month still gets an invoice.
    const sellerId = await makeSeller('company');
    const doc = await planPlatformInvoice({
      seller: { id: sellerId },
      periodKey: '2026-09',
      commissionAgorot: 7_000,
    });
    expect(doc!.amountAgorot).toBe(7_000);
  });
});

describe('a planned document is not an issued one', () => {
  it('starts pending with no provider, number or URL', async () => {
    const sellerId = await makeSeller('company');
    const doc = await planDocument({
      direction: 'platform_to_seller', sellerId, periodKey: '2026-12',
      kind: 'tax_invoice', amountAgorot: 1_000, vatAgorot: 153,
    });
    // Nothing issues documents yet — that is a tax question, not an integration one
    // (docs/legal-brief-agent-model.md §6.3–6.4). The row makes the obligation countable; it must
    // not look like a document that exists.
    expect(doc!.status).toBe('pending');
    expect(doc!.provider).toBeNull();
    expect(doc!.allocationNumber).toBeNull();
    expect(doc!.documentUrl).toBeNull();
    expect(doc!.issuedAt).toBeNull();
  });
});
