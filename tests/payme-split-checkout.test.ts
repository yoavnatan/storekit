/**
 * One card entry, N charges — the split checkout's own rules.
 *
 * `payme-adapter.test.ts` pins what PayMe will and will not accept. This pins what we do with N of
 * those charges in a row, which is where a multi-store cart actually goes wrong:
 *
 *  · The seller's sale is GOODS ONLY. Fold the delivery fee into it and the 60% ceiling refuses it.
 *  · Shipping is ONE charge, on OUR account, with `market_fee: 0`.
 *  · Sellers are charged first and shipping last, so the likelier failure unwinds fewer charges.
 *  · A store that cannot be charged is found BEFORE any charge, never after the first one.
 *  · When store two fails, store one is REFUNDED IN FULL — the exact failure a non-permanent token
 *    produces, and the one the whole design has to survive.
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

const { planSplit, chargeSplit, refundStoreCharge } = await import('../src/lib/payment-split.js');
const { SHIPPING_RATES } = await import('../src/lib/shipping.js');
const { PAYME_MIN_SALE_AGOROT } = await import('../src/lib/payment-payme.js');
const { storeSliceTotalAgorot } = await import('../src/lib/order-totals.js');

const CREDS = { clientKey: 'ck', marketplaceSellerId: 'MPL-US', baseUrl: 'https://sandbox.payme.io/api/' };

/** A two-store cart with courier delivery on both — ₪60 of goods each, ₪30 + ₪30 of shipping. */
function twoStoreCart(overrides: Partial<Parameters<typeof planSplit>[0]> = {}) {
  return {
    buyerKey: 'BK1',
    stores: [
      { storeSlug: 'alef', sellerPaymeId: 'MPL-A', goodsAgorot: 6000, marketFeePercent: 12, productName: 'חנות אלף' },
      { storeSlug: 'bet', sellerPaymeId: 'MPL-B', goodsAgorot: 6000, marketFeePercent: 10, productName: 'חנות בית' },
    ],
    shippingAgorot: 6000,
    marketplaceSellerId: 'MPL-US',
    checkoutRef: 'ABCD1234',
    ...overrides,
  };
}

const sale = (id: string) => ({ status_code: 0, payme_sale_id: id, sale_status: 'completed' });
const refunded = (id: string) => ({ status_code: 0, payme_sale_id: id, sale_status: 'refunded' });
const declined = { status_code: 1, status_error_code: 511, status_error_details: 'Buyer inactive' };

beforeEach(() => { net.replies = []; net.calls = []; });

// ─────────────────────────────────────────────────────────────────────────────

describe('the plan', () => {
  it('charges sellers first and shipping last', () => {
    // Deliberate: a seller's leg can fail for reasons outside our sight (PayMe may restrict any
    // business at their sole discretion, agreement §11) while the shipping leg runs on an account
    // we control. Charging the risky legs first means the common failure unwinds fewer charges.
    const { legs, refusals } = planSplit(twoStoreCart());
    expect(refusals).toEqual([]);
    expect(legs.map((l) => l.kind)).toEqual(['store', 'store', 'shipping']);
  });

  it('gives each store its own merchant account and its own tier commission', () => {
    const { legs } = planSplit(twoStoreCart());
    expect(legs[0]).toMatchObject({ sellerPaymeId: 'MPL-A', amountAgorot: 6000, marketFeePercent: 12 });
    expect(legs[1]).toMatchObject({ sellerPaymeId: 'MPL-B', amountAgorot: 6000, marketFeePercent: 10 });
  });

  it('puts shipping on OUR account, as one charge, with no market fee', () => {
    // One charge for the cart and not one per store: each PayMe transaction costs ₪1 flat, and this
    // money is ours either way. `market_fee: 0` because a commission on our own charge would be us
    // taking a cut from ourselves.
    const shipping = planSplit(twoStoreCart()).legs.find((l) => l.kind === 'shipping')!;
    expect(shipping).toMatchObject({ sellerPaymeId: 'MPL-US', amountAgorot: 6000, marketFeePercent: 0 });
    expect(shipping.storeSlug).toBeUndefined();
  });

  it('skips the shipping leg entirely for a self-pickup-only cart', () => {
    // Zero is not a sale PayMe would take — it is below their minimum — and there is nothing to
    // charge anyway.
    const { legs, refusals } = planSplit(twoStoreCart({ shippingAgorot: 0 }));
    expect(refusals).toEqual([]);
    expect(legs.map((l) => l.kind)).toEqual(['store', 'store']);
  });

  it('refuses a store whose seller has no clearing account, before anything is charged', () => {
    const cart = twoStoreCart();
    cart.stores[1]!.sellerPaymeId = undefined as unknown as string;
    expect(planSplit(cart).refusals).toContainEqual({ reason: 'store-cannot-sell', storeSlug: 'bet' });
  });

  it('refuses a slice below PayMe\'s 500-agorot minimum, and NAMES the store', () => {
    // The buyer's page can only fix the line it is told about. This is also the case that must be
    // caught here rather than at charge time: store one would already be paid.
    const cart = twoStoreCart();
    cart.stores[1]!.goodsAgorot = 499;
    expect(planSplit(cart).refusals).toContainEqual({ reason: 'store-below-minimum', storeSlug: 'bet', amountAgorot: 499 });
  });

  it('collects EVERY refusal, not just the first', () => {
    // A buyer told about one bad line at a time fixes it, resubmits, and is told about the next.
    const cart = twoStoreCart();
    cart.stores[0]!.goodsAgorot = 100;
    cart.stores[1]!.sellerPaymeId = undefined as unknown as string;
    expect(planSplit(cart).refusals).toHaveLength(2);
  });

  it('refuses a non-zero delivery fee under the minimum rather than folding it into a sale', () => {
    // There is nowhere to fold it: putting it on a seller's sale is exactly the 60% ceiling problem
    // the separate shipping charge exists to avoid. Unreachable at today's ₪20/₪30 platform rates —
    // pinned so a future rate cannot introduce it silently.
    expect(planSplit(twoStoreCart({ shippingAgorot: 300 })).refusals)
      .toContainEqual({ reason: 'shipping-below-minimum', amountAgorot: 300 });
  });

  it('refuses when there is delivery to charge and no marketplace account configured', () => {
    expect(planSplit(twoStoreCart({ marketplaceSellerId: undefined })).refusals)
      .toContainEqual({ reason: 'no-marketplace-account' });
  });

  it('derives every PayMe reference from the checkout reference', () => {
    // So their statement and ours can be matched without a lookup table. NOT an idempotency key —
    // PayMe document nothing about refusing a repeat, and that behaviour is unmeasured.
    const { legs } = planSplit(twoStoreCart());
    expect(legs.map((l) => l.transactionId)).toEqual(['ABCD1234-alef', 'ABCD1234-bet', 'ABCD1234-shipping']);
  });
});

describe('charging', () => {
  it('charges goods only — the delivery fee never rides on a seller\'s sale', async () => {
    net.replies.push(sale('S-A'), sale('S-B'), sale('S-SHIP'));
    const input = twoStoreCart();
    await chargeSplit(input, planSplit(input), CREDS);

    // ₪60 of goods, not ₪90. Folding ₪30 of delivery into a ₪60 sale at 12% would put our cut at
    // ₪37.20 of ₪90 — 41%, which passes — but the same fold on a ₪10 item is 87% and is refused.
    // The rule has to hold for every cart, so it holds for this one.
    expect(net.calls[0]!.body.sale_price).toBe(6000);
    expect(net.calls[1]!.body.sale_price).toBe(6000);
    expect(net.calls[2]!.body.sale_price).toBe(6000);
    expect(net.calls[2]!.body.seller_payme_id).toBe('MPL-US');
    expect(net.calls[2]!.body.market_fee).toBe(0);
  });

  it('charges every leg with the SAME buyer token', async () => {
    net.replies.push(sale('S-A'), sale('S-B'), sale('S-SHIP'));
    const input = twoStoreCart();
    await chargeSplit(input, planSplit(input), CREDS);
    expect(net.calls.map((c) => c.body.buyer_key)).toEqual(['BK1', 'BK1', 'BK1']);
  });

  it('returns each store\'s own sale id, so a later refund names one transaction', async () => {
    net.replies.push(sale('S-A'), sale('S-B'), sale('S-SHIP'));
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.charges.map((c) => c.paymeSaleId)).toEqual(['S-A', 'S-B', 'S-SHIP']);
  });
});

describe('when store two fails — the single-use-token failure, survived', () => {
  it('refunds store one IN FULL and reports nothing outstanding', async () => {
    // This is the exact shape a non-permanent token produces: store one completes, store two
    // answers `Buyer inactive`. The adapter always asks for a permanent token, so this should never
    // happen — and if it ever does, the buyer must not be left having paid one of two shops.
    net.replies.push(sale('S-A'), declined, refunded('S-A'));
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('Buyer inactive');
    expect(result.failedAt?.storeSlug).toBe('bet');
    expect(result.refunded.map((r) => r.paymeSaleId)).toEqual(['S-A']);
    expect(result.unrefunded).toEqual([]);

    // A FULL refund: no `sale_refund_amount`. That is what makes it safe at any size — the
    // 500-agorot floor applies only to PARTIAL refunds, so refunding by amount would be refused on
    // exactly the small orders that most need giving back.
    const refund = net.calls[2]!;
    expect(refund.endpoint).toBe('refund-sale');
    expect(refund.body).not.toHaveProperty('sale_refund_amount');
    expect(refund.body.payme_sale_id).toBe('S-A');
    expect(refund.body.seller_payme_id).toBe('MPL-A');
  });

  it('never charges the third leg once the second refused', async () => {
    net.replies.push(sale('S-A'), declined, refunded('S-A'));
    const input = twoStoreCart();
    await chargeSplit(input, planSplit(input), CREDS);
    // Two sales attempted, one refund. Sequential charging is what guarantees the set to unwind is
    // exactly the set already completed — concurrent legs would mean refunding transactions that
    // do not exist yet.
    expect(net.calls.map((c) => c.endpoint)).toEqual(['generate-sale', 'generate-sale', 'refund-sale']);
  });

  it('unwinds newest-first, so the charge the buyer just saw disappears first', async () => {
    net.replies.push(sale('S-A'), sale('S-B'), declined, refunded('S-B'), refunded('S-A'));
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refunded.map((r) => r.paymeSaleId)).toEqual(['S-B', 'S-A']);
  });

  it('when the SHIPPING leg fails, both sellers are refunded', async () => {
    net.replies.push(sale('S-A'), sale('S-B'), declined, refunded('S-B'), refunded('S-A'));
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedAt?.kind).toBe('shipping');
    expect(result.refunded).toHaveLength(2);
    expect(result.unrefunded).toEqual([]);
  });

  it('treats a sale that is not `completed` as a failure and unwinds it', async () => {
    // `authorized` is a hold, not money, and this platform's rule is that an order exists only when
    // money really moved. Guessing that an unknown status means "paid" is how an unpaid order
    // becomes shippable.
    net.replies.push(sale('S-A'), { status_code: 0, payme_sale_id: 'S-B', sale_status: 'authorized' }, refunded('S-B'), refunded('S-A'));
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("came back 'authorized'");
  });
});

describe('when the refund itself fails', () => {
  it('reports the charge as unrefunded instead of swallowing it', async () => {
    // The one outcome that costs a real person real money with nothing else pointing at it. It must
    // reach the caller, which journals it and raises an alert; a compensation that quietly gives up
    // is worse than none, because it looks like it worked.
    net.replies.push(sale('S-A'), declined, { status_code: 1, status_error_code: 305, status_error_details: 'Cannot perform action due to an incorrect status' });
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refunded).toEqual([]);
    expect(result.unrefunded).toHaveLength(1);
    expect(result.unrefunded[0]!.leg.paymeSaleId).toBe('S-A');
    expect(result.unrefunded[0]!.error).toContain('incorrect status');
  });

  it('still refunds the others when one refund fails', async () => {
    net.replies.push(
      sale('S-A'), sale('S-B'), declined,
      { status_code: 1, status_error_code: 305, status_error_details: 'nope' },   // S-B refund fails
      refunded('S-A'),                                                            // S-A refund works
    );
    const input = twoStoreCart();
    const result = await chargeSplit(input, planSplit(input), CREDS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refunded.map((r) => r.paymeSaleId)).toEqual(['S-A']);
    expect(result.unrefunded.map((u) => u.leg.paymeSaleId)).toEqual(['S-B']);
  });

  it('never throws, whatever PayMe answer', async () => {
    // It runs inside a failure path that still has to restock, release the idempotency claim and
    // log. A compensation that can itself throw turns one bad outcome into four.
    net.replies.push(sale('S-A'), declined, '<html>gateway timeout</html>');
    const input = twoStoreCart();
    await expect(chargeSplit(input, planSplit(input), CREDS)).resolves.toMatchObject({ ok: false });
  });
});

describe('the buyer is charged exactly what the order says — the invariant', () => {
  /** `storeSliceTotalAgorot`'s definition, restated from the other side: goods + shipping − the
   *  seller's discount. The split cuts that total in a different place (goods to the seller,
   *  shipping to us), so the only thing that must hold is that the pieces add back up. */
  function orderTotals(slices: { subtotalAgorot: number; shippingAgorot: number; discount?: { appliedAgorot: number } }[]): number {
    return slices.reduce((sum, s) => sum + storeSliceTotalAgorot(s), 0);
  }

  it('the legs sum to the sum of the order totals, with and without discounts', () => {
    // The failure this catches is the one that would be invisible: charge the seller's goods
    // WITHOUT subtracting his coupon, and every order card says ₪80 while the buyer's card says
    // ₪100. Nothing else in this repo compares those two numbers, because until now there was one
    // charge and it was the total by construction.
    const slices = [
      { subtotalAgorot: 6000, shippingAgorot: 3000 },
      { subtotalAgorot: 9000, shippingAgorot: 3000, discount: { appliedAgorot: 1500 } },
    ];
    const { legs, refusals } = planSplit({
      buyerKey: 'BK1',
      stores: slices.map((s, i) => ({
        storeSlug: `s${i}`,
        sellerPaymeId: `MPL-${i}`,
        goodsAgorot: s.subtotalAgorot - (s.discount?.appliedAgorot ?? 0),
        marketFeePercent: 12,
        productName: `s${i}`,
      })),
      shippingAgorot: slices.reduce((sum, s) => sum + s.shippingAgorot, 0),
      marketplaceSellerId: 'MPL-US',
      checkoutRef: 'REF',
    });
    expect(refusals).toEqual([]);
    expect(legs.reduce((sum, l) => sum + l.amountAgorot, 0)).toBe(orderTotals(slices));
  });

  it('a self-pickup cart still sums, with no shipping leg at all', () => {
    const slices = [{ subtotalAgorot: 6000, shippingAgorot: 0 }];
    const { legs } = planSplit({
      buyerKey: 'BK1',
      stores: [{ storeSlug: 's0', sellerPaymeId: 'MPL-0', goodsAgorot: 6000, marketFeePercent: 12, productName: 's0' }],
      shippingAgorot: 0,
      marketplaceSellerId: 'MPL-US',
      checkoutRef: 'REF',
    });
    expect(legs.reduce((sum, l) => sum + l.amountAgorot, 0)).toBe(orderTotals(slices));
  });
});

describe('the platform\'s shipping rates have to be chargeable', () => {
  it('every rate is at or above PayMe\'s minimum sale', () => {
    // The shipping leg is a sale like any other, so a rate below ₪5 is a rate no cart can pay.
    // `SHIPPING_RATES` are explicitly PLACEHOLDERS awaiting the carrier's real tariff
    // (`lib/shipping.ts` header), which is precisely why this is pinned: the day those numbers are
    // replaced, a cheap pickup-point rate would make `shipping-below-minimum` reachable on real
    // carts, and it would surface as a refused checkout rather than as a failing test.
    for (const [method, ils] of Object.entries(SHIPPING_RATES)) {
      expect(Math.round(ils * 100), `${method} is below PayMe's minimum sale`).toBeGreaterThanOrEqual(PAYME_MIN_SALE_AGOROT);
    }
  });
});

describe('refunding one slice later — a cancelled order', () => {
  it('sends the amount for a partial refund', async () => {
    net.replies.push({ status_code: 0, payme_sale_id: 'S-A', sale_status: 'partial-refund' });
    await refundStoreCharge({ sellerPaymeId: 'MPL-A', paymeSaleId: 'S-A', amountAgorot: 2000 }, CREDS);
    expect(net.calls[0]!.body.sale_refund_amount).toBe(2000);
  });

  it('refuses a partial refund below the minimum rather than reporting a refund that did not happen', async () => {
    // The case callers get wrong: a multi-store order where only one small slice is cancelled. A ₪3
    // remainder is not refundable in part, and the caller has to know that — silently rounding it
    // up to ₪5 would give the buyer ₪2 that is not theirs, out of the seller's account.
    const result = await refundStoreCharge({ sellerPaymeId: 'MPL-A', paymeSaleId: 'S-A', amountAgorot: 300 }, CREDS);
    expect(result).toMatchObject({ ok: false });
    expect(net.calls).toHaveLength(0);
  });

  it('reverses the whole sale at any size when no amount is given', async () => {
    net.replies.push(refunded('S-A'));
    const result = await refundStoreCharge({ sellerPaymeId: 'MPL-A', paymeSaleId: 'S-A' }, CREDS);
    expect(result).toMatchObject({ ok: true, saleStatus: 'refunded' });
    expect(net.calls[0]!.body).not.toHaveProperty('sale_refund_amount');
  });
});
