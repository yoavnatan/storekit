/**
 * Giving the buyer's money back — the half that was recorded and never performed.
 *
 * Until 2026-08-23 `refund_due` was written by three code paths and `refund_settled` by nothing at
 * all, so a cancelled paid order left the buyer's money exactly where it was. Every case here is a
 * way the fix could be worse than the gap:
 *
 *  · refunding the SELLER's merchant account for delivery, which was never captured into it;
 *  · rounding a ₪3 residue up to PayMe's ₪5 floor — handing back money nobody agreed to;
 *  · reporting a refund as settled when the gateway refused it, which closes an obligation
 *    `reconcile.ts` would otherwise keep reporting;
 *  · writing `refund_settled` with no order id, which leaves the obligation open forever while the
 *    money really went back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  /** Every `refundStoreCapture` call, in order. */
  refunds: [] as { sellerPaymeId: string; paymeSaleId: string; amountAgorot?: number }[],
  /** What the next refund should answer. */
  refundOk: true,
  refundError: 'gateway refused',
  events: [] as Record<string, unknown>[],
  errors: [] as Record<string, unknown>[],
  /** The delivery capture id in the journal, or null when it was never recorded. */
  deliveryRef: 'SALE-DELIVERY' as string | null,
  merchantRef: 'MPL-SELLER' as string | null,
}));

vi.mock('../src/lib/db.js', () => ({
  rows: async () => (rig.deliveryRef ? [{ to_value: rig.deliveryRef }] : []),
}));
vi.mock('../src/lib/stores.js', () => ({
  getStoreBySlug: async (slug: string) => ({ id: 'st1', slug, sellerId: 'seller-1' }),
}));
vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantAccountFor: async () => (rig.merchantRef ? { sellerId: 'seller-1', providerRef: rig.merchantRef } : null),
}));
vi.mock('../src/lib/payment-split.js', () => ({
  refundStoreCapture: async (input: { sellerPaymeId: string; paymeSaleId: string; amountAgorot?: number }) => {
    rig.refunds.push(input);
    return rig.refundOk ? { ok: true, saleStatus: 'refunded' } : { ok: false, error: rig.refundError };
  },
}));
vi.mock('../src/lib/money-events.js', () => ({
  recordMoneyEvent: async (e: Record<string, unknown>) => { rig.events.push(e); return e; },
}));
vi.mock('../src/lib/error-log.js', () => ({
  logError: async (e: Record<string, unknown>) => { rig.errors.push(e); },
}));

const { settleRefund, refundableAsPartial, deliveryCaptureRef } = await import('../src/lib/refund-execute.js');

const CREDS = { clientKey: 'k', ownMerchantId: 'MPL-OURS', baseUrl: 'https://sandbox.payme.io/api/' };

/** ₪100 of goods and ₪30 of delivery, captured as two charges against two different merchants. */
function order(over: Record<string, unknown> = {}) {
  return {
    id: 'order-1', checkoutRef: 'CHK1', paymentRef: 'SALE-STORE',
    totalAgorot: 13000, shippingAgorot: 3000,
    items: [], storeSubtotals: {}, buyerName: '', buyerEmail: '', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    paymentStatus: 'paid', shippingStatus: 'cancelled',
    ...over,
  } as never;
}

beforeEach(() => {
  rig.refunds = [];
  rig.refundOk = true;
  rig.events = [];
  rig.errors = [];
  rig.deliveryRef = 'SALE-DELIVERY';
  rig.merchantRef = 'MPL-SELLER';
});

describe('the two legs go to two different merchants', () => {
  // The whole point of the split: the goods were captured into the SELLER's account and the
  // delivery into OURS. One refund of ₪130 against either would be a refund of money that never
  // reached it.
  it('refunds goods from the seller and delivery from us, each against its own capture', async () => {
    const out = await settleRefund({
      order: order(), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 10000, shippingAgorot: 3000 },
    }, CREDS);

    expect(out.ok).toBe(true);
    expect(out.settledAgorot).toBe(13000);
    expect(rig.refunds).toEqual([
      // No `amountAgorot`: both are FULL reversals of their own captures, which is what PayMe want
      // and what removes their minimum from the question entirely.
      { sellerPaymeId: 'MPL-SELLER', paymeSaleId: 'SALE-STORE' },
      { sellerPaymeId: 'MPL-OURS', paymeSaleId: 'SALE-DELIVERY' },
    ]);
  });

  it('touches only the goods leg when the delivery is not being given back', async () => {
    await settleRefund({
      order: order(), storeSlug: 'shop', source: 'return-approved', actor: 'seller-1',
      parts: { goodsAgorot: 4000, shippingAgorot: 0 },
    }, CREDS);
    expect(rig.refunds).toEqual([{ sellerPaymeId: 'MPL-SELLER', paymeSaleId: 'SALE-STORE', amountAgorot: 4000 }]);
  });

  // The delivery charge belongs to the CART, so no order row can hold its id (GO_LIVE §3.1.2). It
  // comes out of the journal — and if it is not there, the refund is not attempted at all rather
  // than sent against a guess.
  it('refuses the delivery leg rather than guess when the journal has no reference for it', async () => {
    rig.deliveryRef = null;
    const out = await settleRefund({
      order: order(), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 10000, shippingAgorot: 3000 },
    }, CREDS);
    expect(rig.refunds.map((r) => r.sellerPaymeId)).toEqual(['MPL-SELLER']);
    expect(out.legs).toContainEqual({ leg: 'delivery', status: 'no-reference' });
    expect(out.ok).toBe(false);
    expect(rig.errors).toHaveLength(1);
  });
});

describe("PayMe's ₪5 partial floor, and the thing not to do about it", () => {
  // Rounding a residue UP hands back money nobody agreed to. Skipping it silently leaves a buyer
  // short with no record. Neither: it is refused, with the number, and the obligation stays open.
  it('refuses a partial below the floor instead of rounding it up', async () => {
    const out = await settleRefund({
      order: order(), storeSlug: 'shop', source: 'partial-item', actor: 'seller-1',
      parts: { goodsAgorot: 300, shippingAgorot: 0 },
    }, CREDS);
    expect(rig.refunds).toEqual([]);
    expect(out.settledAgorot).toBe(0);
    expect(out.legs).toContainEqual({ leg: 'goods', status: 'below-minimum', amountAgorot: 300, minimumAgorot: 500 });
    // Nothing settled, so nothing may claim it did — `reconcile.ts` must keep reporting this one.
    expect(rig.events).toEqual([]);
  });

  // The one way round the floor, and it is PayMe's own rule rather than a trick: a FULL reversal
  // has no minimum. So a ₪3 order really can be given back — whole.
  it('gives a sub-floor amount back in full when it IS the whole capture', async () => {
    const out = await settleRefund({
      order: order({ totalAgorot: 300, shippingAgorot: 0 }), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 300, shippingAgorot: 0 },
    }, CREDS);
    expect(rig.refunds).toEqual([{ sellerPaymeId: 'MPL-SELLER', paymeSaleId: 'SALE-STORE' }]);
    expect(out.settledAgorot).toBe(300);
    expect(out.ok).toBe(true);
  });

  it('states the rule the same way on its own', () => {
    expect(refundableAsPartial(300, 10000)).toBe(false);   // under the floor
    expect(refundableAsPartial(500, 10000)).toBe(true);    // exactly the floor
    expect(refundableAsPartial(10000, 10000)).toBe(false); // not a partial at all — a full reversal
  });
});

describe('what gets written down', () => {
  // `reconcile.ts` pairs a settlement against an obligation BY ORDER ID. Without one the obligation
  // is reported as outstanding forever while the money has really gone back — a report that is
  // wrong in the direction nobody investigates.
  it('names the order on the settlement, so the obligation can be paired off', async () => {
    await settleRefund({
      order: order(), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 10000, shippingAgorot: 3000 },
    }, CREDS);
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({
      type: 'refund_settled', orderId: 'order-1', checkoutRef: 'CHK1', storeSlug: 'shop', amountAgorot: 13000,
    });
  });

  // A gateway refusal must not read as a refund. The buyer is owed the money either way, and the
  // difference between the two is whether anybody ever finds out.
  it('reports a refused refund as unsettled, writes no settlement, and says so out loud', async () => {
    rig.refundOk = false;
    const out = await settleRefund({
      order: order(), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 10000, shippingAgorot: 0 },
    }, CREDS);
    expect(out.ok).toBe(false);
    expect(out.settledAgorot).toBe(0);
    expect(rig.events).toEqual([]);
    expect(rig.errors).toHaveLength(1);
  });

  // Half a refund is the case worth pinning: the settlement records what really moved, and the
  // failure is still loud. Recording the full amount here would close an obligation with money
  // still owed.
  it('records only the leg that succeeded when the other one failed', async () => {
    rig.merchantRef = null;                     // the goods leg cannot even be attempted
    const out = await settleRefund({
      order: order(), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 10000, shippingAgorot: 3000 },
    }, CREDS);
    expect(out.settledAgorot).toBe(3000);
    expect(out.ok).toBe(false);
    expect(rig.events[0]).toMatchObject({ type: 'refund_settled', amountAgorot: 3000 });
  });

  // With no gateway nothing can move, and the obligation must stay exactly where `refund-owed.ts`
  // put it. A "success" here is the one outcome that would make the journal lie.
  it('settles nothing and claims nothing when no provider is configured', async () => {
    const out = await settleRefund({
      order: order(), storeSlug: 'shop', source: 'seller-cancel', actor: 'seller-1',
      parts: { goodsAgorot: 10000, shippingAgorot: 3000 },
    }, null);
    expect(out.ok).toBe(false);
    expect(out.settledAgorot).toBe(0);
    expect(rig.refunds).toEqual([]);
    expect(rig.events).toEqual([]);
  });
});

describe('deliveryCaptureRef', () => {
  it('reads the delivery leg out of the journal, and answers null with no checkout to look under', async () => {
    expect(await deliveryCaptureRef('CHK1')).toBe('SALE-DELIVERY');
    expect(await deliveryCaptureRef('')).toBeNull();
  });
});
