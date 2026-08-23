/**
 * One card, one authorization, one capture per store — the multi-seller checkout's own rules.
 *
 * `payme-adapter.test.ts` pins what PayMe will and will not accept. This pins what we do with an
 * authorization and N captures, which is where a multi-store cart actually goes wrong. Every rule
 * below comes from a measurement recorded in `docs/payme-sandbox-notes.md` §14–15:
 *
 *  · ONE authorization holds the whole cart; each store's capture draws a slice of it.
 *  · A capture may name a DIFFERENT seller from the one the authorization was created on.
 *  · Delivery rides inside its store's capture as `market_fee_fixed` — there is no account of ours
 *    to charge it to separately, and charging the partner id is refused 174.
 *  · Captures may not exceed the authorization, so the legs must sum to exactly what was held.
 *  · A failure before the first capture RELEASES the hold; after it, refunds what completed.
 *  · A refund that itself fails is reported, never swallowed: that is a real person's money.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = vi.hoisted(() => ({
  replies: [] as unknown[],
  calls: [] as { endpoint: string; body: Record<string, unknown> }[],
}));

vi.mock('../src/lib/outbound-fetch.js', () => ({
  outboundFetch: async (url: string, init: { body: string }) => {
    net.calls.push({
      endpoint: url.split('/').pop() ?? '',
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const reply = net.replies.shift() ?? { status_code: 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify(reply) } as Response;
  },
}));

const { planSplit, authorizeCart, captureSlices, releaseAuthorization, refundStoreCapture } =
  await import('../src/lib/payment-split.js');
const { SHIPPING_RATES } = await import('../src/lib/shipping.js');
const { PAYME_MIN_SALE_AGOROT } = await import('../src/lib/payment-payme.js');
const { storeSliceTotalAgorot } = await import('../src/lib/order-totals.js');

const CREDS = { clientKey: 'ck', marketplaceSellerId: 'MPL-US', baseUrl: 'https://sandbox.payme.io/api/' };

/** Two stores, ₪60 of goods each, ₪30 of courier delivery each. */
function twoStoreCart(overrides: Partial<Parameters<typeof planSplit>[0]> = {}) {
  return {
    buyerKey: 'BK1',
    stores: [
      { storeSlug: 'alef', sellerPaymeId: 'MPL-A', goodsAgorot: 6000, shippingAgorot: 3000, marketFeePercent: 12, productName: 'חנות אלף' },
      { storeSlug: 'bet', sellerPaymeId: 'MPL-B', goodsAgorot: 6000, shippingAgorot: 3000, marketFeePercent: 10, productName: 'חנות בית' },
    ],
    checkoutRef: 'ABCD1234',
    ...overrides,
  };
}

const authorized = (id: string) => ({ status_code: 0, payme_sale_id: id, sale_status: 'authorized' });
const captured = (id: string) => ({ status_code: 0, payme_sale_id: id, sale_status: 'completed' });
const refunded = (id: string) => ({ status_code: 0, payme_sale_id: id, sale_status: 'refunded' });
const voided = (id: string) => ({ status_code: 0, payme_sale_id: id, sale_status: 'voided' });
const declined = { status_code: 1, status_error_code: 352, status_error_details: 'סכום העסקה חורג מהמגבלות' };

beforeEach(() => { net.replies = []; net.calls = []; });

// ─────────────────────────────────────────────────────────────────────────────

describe('the plan', () => {
  it('holds the WHOLE cart and splits it into one capture per store', () => {
    const plan = planSplit(twoStoreCart());
    expect(plan.refusals).toEqual([]);
    expect(plan.legs.map((l) => l.storeSlug)).toEqual(['alef', 'bet']);
    // ₪60 goods + ₪30 delivery, twice.
    expect(plan.legs.map((l) => l.amountAgorot)).toEqual([9000, 9000]);
    expect(plan.authorizeAgorot).toBe(18000);
  });

  it('creates the authorization on the FIRST store\'s merchant, deterministically', () => {
    // Any of the cart's sellers would do — an authorization on seller A was measured being captured
    // by seller B — so the choice is made once and reproducibly rather than left to iteration order.
    expect(planSplit(twoStoreCart()).authorizeOn).toBe('MPL-A');
  });

  it('carries each store\'s delivery as the FIXED fee on its own capture', () => {
    // There is no merchant account of ours to charge delivery to: the partner id is refused 174.
    // So it rides inside the store's capture and comes back to us as market_fee_fixed.
    const plan = planSplit(twoStoreCart());
    expect(plan.legs.map((l) => l.marketFeeFixedAgorot)).toEqual([3000, 3000]);
  });

  it('gives each store its own merchant and its own tier commission', () => {
    const plan = planSplit(twoStoreCart());
    expect(plan.legs[0]).toMatchObject({ sellerPaymeId: 'MPL-A', marketFeePercent: 12 });
    expect(plan.legs[1]).toMatchObject({ sellerPaymeId: 'MPL-B', marketFeePercent: 10 });
  });

  it('carries a zero delivery fee for self-pickup rather than dropping it', () => {
    // `0` must reach PayMe as `0`. Omitting the field falls back to the merchant's stored default,
    // which would take a fee nobody agreed to.
    const cart = twoStoreCart();
    cart.stores[0]!.shippingAgorot = 0;
    const plan = planSplit(cart);
    expect(plan.legs[0]).toMatchObject({ amountAgorot: 6000, marketFeeFixedAgorot: 0 });
  });

  it('refuses a store whose seller has no clearing account', () => {
    const cart = twoStoreCart();
    cart.stores[1]!.sellerPaymeId = undefined as unknown as string;
    expect(planSplit(cart).refusals).toContainEqual({ reason: 'store-cannot-sell', storeSlug: 'bet' });
  });

  it('refuses a slice below PayMe\'s 500-agorot minimum, and NAMES the store', () => {
    const cart = twoStoreCart();
    cart.stores[1]!.goodsAgorot = 100;
    cart.stores[1]!.shippingAgorot = 0;
    expect(planSplit(cart).refusals).toContainEqual({ reason: 'store-below-minimum', storeSlug: 'bet', amountAgorot: 100 });
  });

  it('refuses a cheap item with real delivery — the 60% case PayMe were asked to raise', () => {
    // ₪10 of goods with ₪30 of delivery: our cut is 12% of ₪40 plus the ₪30, i.e. 87%. This is now
    // reachable in ordinary trading, because delivery rides on the capture rather than sitting on a
    // charge of its own — which is exactly why the ceiling has to move.
    const cart = twoStoreCart();
    cart.stores[0]!.goodsAgorot = 1000;
    expect(planSplit(cart).refusals).toContainEqual({ reason: 'store-fee-ceiling', storeSlug: 'alef' });
  });

  it('collects EVERY refusal, not just the first', () => {
    const cart = twoStoreCart();
    cart.stores[0]!.goodsAgorot = 100;
    cart.stores[0]!.shippingAgorot = 0;
    cart.stores[1]!.sellerPaymeId = undefined as unknown as string;
    expect(planSplit(cart).refusals).toHaveLength(2);
  });

  it('derives every PayMe reference from the checkout reference', () => {
    expect(planSplit(twoStoreCart()).legs.map((l) => l.transactionId)).toEqual(['ABCD1234-alef', 'ABCD1234-bet']);
  });
});

describe('the buyer is charged exactly what the order says — the invariant', () => {
  it('the legs sum to the authorization, and to the sum of the order totals', () => {
    // The failure this catches would be invisible: capture goods WITHOUT the coupon and every order
    // card says one number while the buyer's card says another. And because captures may not exceed
    // the authorization (measured, 352), a leg that drifted upward would be refused mid-checkout.
    const slices = [
      { subtotalAgorot: 6000, shippingAgorot: 3000 },
      { subtotalAgorot: 9000, shippingAgorot: 3000, discount: { appliedAgorot: 1500 } },
    ];
    const plan = planSplit({
      buyerKey: 'BK1',
      checkoutRef: 'REF',
      stores: slices.map((s, i) => ({
        storeSlug: `s${i}`,
        sellerPaymeId: `MPL-${i}`,
        goodsAgorot: s.subtotalAgorot - (s.discount?.appliedAgorot ?? 0),
        shippingAgorot: s.shippingAgorot,
        marketFeePercent: 12,
        productName: `s${i}`,
      })),
    });
    expect(plan.refusals).toEqual([]);
    const legs = plan.legs.reduce((sum, l) => sum + l.amountAgorot, 0);
    expect(legs).toBe(plan.authorizeAgorot);
    expect(legs).toBe(slices.reduce((sum, s) => sum + storeSliceTotalAgorot(s), 0));
  });
});

describe('the platform\'s delivery rates have to be chargeable', () => {
  it('every rate is at or above PayMe\'s minimum sale', () => {
    // A store's capture is goods + delivery, so a rate alone is never the whole sale — but a
    // pickup-only order of a cheap item is, and these are PLACEHOLDERS awaiting the carrier's real
    // tariff (`lib/shipping.ts`). Pinned so a future rate cannot make `store-below-minimum`
    // reachable without the test saying so.
    for (const [method, ils] of Object.entries(SHIPPING_RATES)) {
      expect(Math.round(ils * 100), `${method} is below PayMe's minimum sale`).toBeGreaterThanOrEqual(PAYME_MIN_SALE_AGOROT);
    }
  });
});

describe('authorizing', () => {
  it('holds the cart total on ONE merchant, with the buyer token and no market fee', async () => {
    net.replies.push(authorized('AUTH1'));
    const input = twoStoreCart();
    const res = await authorizeCart(input, planSplit(input), CREDS);
    expect(res).toMatchObject({ ok: true, authorizationId: 'AUTH1' });
    const body = net.calls[0]!.body;
    expect(body).toMatchObject({
      seller_payme_id: 'MPL-A', sale_price: 18000, sale_type: 'authorize', buyer_key: 'BK1',
    });
    // No commission on the hold — our cut belongs to a particular seller's capture, and charging it
    // here would attribute the whole cart's commission to whichever store happened to be first.
    expect(body.market_fee).toBe(0);
  });

  it('reports a refusal instead of throwing', async () => {
    net.replies.push({ status_code: 1, status_error_code: 511, status_error_details: 'Buyer inactive' });
    const input = twoStoreCart();
    await expect(authorizeCart(input, planSplit(input), CREDS)).resolves.toMatchObject({ ok: false });
  });
});

describe('capturing', () => {
  it('draws each slice out of the SAME authorization, naming each store\'s own merchant', async () => {
    net.replies.push(captured('CAP-A'), captured('CAP-B'));
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(true);

    for (const call of net.calls) {
      expect(call.body.sale_type).toBe('multi-capture');
      expect(call.body.origin_sale_id).toBe('AUTH1');
      // The token is spent on the authorization, not on the captures.
      expect(call.body).not.toHaveProperty('buyer_key');
    }
    expect(net.calls.map((c) => c.body.seller_payme_id)).toEqual(['MPL-A', 'MPL-B']);
    expect(net.calls.map((c) => c.body.market_fee_fixed)).toEqual([30, 30]);   // SHEKELS
    expect(net.calls.map((c) => c.body.sale_price)).toEqual([9000, 9000]);     // agorot
  });

  it('returns each store\'s own capture id, so a later refund names one transaction', async () => {
    net.replies.push(captured('CAP-A'), captured('CAP-B'));
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.captures.map((c) => [c.storeSlug, c.paymeSaleId])).toEqual([['alef', 'CAP-A'], ['bet', 'CAP-B']]);
  });
});

describe('when a capture fails', () => {
  it('RELEASES the hold when nothing had been captured yet', async () => {
    // The buyer's card was held for a moment and nothing was taken. Measured: `refund-sale` against
    // an uncaptured authorization answers `voided`.
    net.replies.push(declined, voided('AUTH1'));
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.voided).toBe(true);
    expect(res.refunded).toEqual([]);
    expect(net.calls[1]!.endpoint).toBe('refund-sale');
    expect(net.calls[1]!.body.payme_sale_id).toBe('AUTH1');
  });

  it('refunds store one IN FULL when store two fails', async () => {
    net.replies.push(captured('CAP-A'), declined, refunded('CAP-A'));
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failedAt?.storeSlug).toBe('bet');
    expect(res.refunded.map((r) => r.paymeSaleId)).toEqual(['CAP-A']);
    expect(res.unrefunded).toEqual([]);
    // A FULL refund carries no amount — the 500-agorot floor applies to partial refunds only, so
    // refunding by amount would be refused on exactly the small orders that most need giving back.
    const refund = net.calls[2]!;
    expect(refund.endpoint).toBe('refund-sale');
    expect(refund.body).not.toHaveProperty('sale_refund_amount');
    expect(refund.body.payme_sale_id).toBe('CAP-A');
  });

  it('does not also void the authorization once something was captured', async () => {
    // The hold is spent; refunding the capture is what gives the money back. Voiding on top would
    // be a second reversal of the same money.
    net.replies.push(captured('CAP-A'), declined, refunded('CAP-A'));
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.voided).toBe(false);
  });

  it('treats a capture that is not `completed` as a failure and unwinds it', async () => {
    // `authorized` is a hold, not money. Guessing that an unknown status means paid is how an
    // unpaid order becomes shippable.
    net.replies.push(captured('CAP-A'), { status_code: 0, payme_sale_id: 'CAP-B', sale_status: 'authorized' }, refunded('CAP-B'), refunded('CAP-A'));
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toContain("came back 'authorized'");
    // Both are unwound — the unpaid one exists as a sale and is refunded too.
    expect(res.refunded.map((r) => r.paymeSaleId)).toEqual(['CAP-B', 'CAP-A']);
  });

  it('unwinds newest-first, so the charge the buyer just saw disappears first', async () => {
    net.replies.push(captured('CAP-A'), captured('CAP-B'), declined, refunded('CAP-B'), refunded('CAP-A'));
    const cart = twoStoreCart();
    cart.stores.push({ storeSlug: 'gimel', sellerPaymeId: 'MPL-C', goodsAgorot: 6000, shippingAgorot: 0, marketFeePercent: 12, productName: 'ג' });
    const res = await captureSlices('AUTH1', cart, planSplit(cart), CREDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refunded.map((r) => r.paymeSaleId)).toEqual(['CAP-B', 'CAP-A']);
  });
});

describe('when the refund itself fails', () => {
  it('reports the capture as unrefunded instead of swallowing it', async () => {
    net.replies.push(captured('CAP-A'), declined, { status_code: 1, status_error_code: 305, status_error_details: 'incorrect status' });
    const input = twoStoreCart();
    const res = await captureSlices('AUTH1', input, planSplit(input), CREDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refunded).toEqual([]);
    expect(res.unrefunded).toHaveLength(1);
    expect(res.unrefunded[0]!.leg.paymeSaleId).toBe('CAP-A');
  });

  it('never throws, whatever PayMe answer', async () => {
    net.replies.push(captured('CAP-A'), declined, '<html>gateway timeout</html>');
    const input = twoStoreCart();
    await expect(captureSlices('AUTH1', input, planSplit(input), CREDS)).resolves.toMatchObject({ ok: false });
  });
});

describe('releasing and refunding after the fact', () => {
  it('releases an abandoned authorization', async () => {
    net.replies.push(voided('AUTH1'));
    await expect(releaseAuthorization('MPL-A', 'AUTH1', CREDS)).resolves.toMatchObject({ ok: true });
  });

  it('sends the amount for a partial refund of one store\'s capture', async () => {
    net.replies.push({ status_code: 0, payme_sale_id: 'CAP-A', sale_status: 'partial-refund' });
    await refundStoreCapture({ sellerPaymeId: 'MPL-A', paymeSaleId: 'CAP-A', amountAgorot: 2000 }, CREDS);
    expect(net.calls[0]!.body.sale_refund_amount).toBe(2000);
  });

  it('refuses a partial refund below the minimum rather than reporting one that did not happen', async () => {
    // A ₪3 remainder is not refundable in part. Silently rounding up to ₪5 would give the buyer ₪2
    // that is not theirs, out of the seller's account.
    await expect(refundStoreCapture({ sellerPaymeId: 'MPL-A', paymeSaleId: 'CAP-A', amountAgorot: 300 }, CREDS))
      .resolves.toMatchObject({ ok: false });
    expect(net.calls).toHaveLength(0);
  });

  it('reverses the whole capture at any size when no amount is given', async () => {
    net.replies.push(refunded('CAP-A'));
    await expect(refundStoreCapture({ sellerPaymeId: 'MPL-A', paymeSaleId: 'CAP-A' }, CREDS))
      .resolves.toMatchObject({ ok: true, saleStatus: 'refunded' });
    expect(net.calls[0]!.body).not.toHaveProperty('sale_refund_amount');
  });
});
