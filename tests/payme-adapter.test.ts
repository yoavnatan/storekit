/**
 * The PayMe adapter — their rules, pinned.
 *
 * Not "does the function run" tests. Every case here is a way a real PayMe integration silently
 * takes the wrong amount of money, refuses a payment that should work, or accepts a callback that
 * nobody sent — and each one comes from a MEASUREMENT against their live sandbox
 * (`docs/payme-sandbox-notes.md`, `GO_LIVE_CHECKLIST.md` §3.1.1) rather than from our own code:
 *
 *  · `sale_price` is AGOROT and `market_fee_fixed` is SHEKELS, in the same request.
 *  · A buyer token is single-use unless it is asked for as PERMANENT — store two fails without it.
 *  · Minimum sale and minimum partial refund: 500 agorot.
 *  · Our total cut is capped at 60% of the sale.
 *  · `status_code` decides success, not the HTTP status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = vi.hoisted(() => ({
  replies: [] as unknown[],
  calls: [] as { url: string; body: Record<string, unknown> }[],
  httpStatus: 200,
}));

vi.mock('../src/lib/outbound-fetch.js', () => ({
  outboundFetch: async (url: string, init: { body: string }) => {
    net.calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = net.replies.shift() ?? { status_code: 0 };
    return {
      ok: net.httpStatus < 400,
      status: net.httpStatus,
      text: async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)),
    } as Response;
  },
}));

const {
  PAYME_MIN_SALE_AGOROT, PAYME_MIN_REFUND_AGOROT, PAYME_MAX_MARKET_FEE_PERCENT,
  PaymeError, isSandbox, paymeCredentials, paymeIsActive, activePaymeCredentials,
  marketFeeFixedShekels, marketFeeTotalAgorot, exceedsMarketFeeCeiling, refuseSale, saleIsPaid,
  createSeller, captureBuyerToken, generateSale, refundSale,
  callbackSignature, verifyCallbackSignature,
} = await import('../src/lib/payment-payme.js');

const CREDS = { clientKey: 'test-client-key', marketplaceSellerId: 'MPL-US', baseUrl: 'https://sandbox.payme.io/api/' };

/** The body of the last request the adapter built. */
function lastBody(): Record<string, unknown> {
  return net.calls[net.calls.length - 1]!.body;
}

const SELLER_INPUT = {
  firstName: 'Dezabin', lastName: 'TestC', socialId: '9999999999',
  birthdate: '06/05/1989', socialIdIssued: '01/01/2000', gender: 0 as const,
  email: 'random@paymeservice.com', phone: '+972500000099',
  bankCode: '54', bankBranch: '123', bankAccount: '123456',
  description: 'A test store', siteUrl: 'https://dezabin.co.il',
  businessType: '2000', incorporation: 2, businessId: '123456', merchantName: 'Test',
  registrationDate: '06/05/2020',
  addressCity: 'Tel Aviv', addressStreet: 'Rothschild', addressStreetNumber: '45',
  marketFeePercent: 12,
};

beforeEach(() => { net.replies = []; net.calls = []; net.httpStatus = 200; });

// ─────────────────────────────────────────────────────────────────────────────

describe('the unit trap: sale_price in agorot, market_fee_fixed in shekels', () => {
  it('converts a fixed fee to shekels without float drift', () => {
    // Asserted on the STRING form, which is the thing that actually matters and also the thing a
    // float comparison cannot express: what PayMe receive is `JSON.stringify` of this number, so
    // the question is never "is it close to 10.15", it is "does the wire carry `10.15`".
    // 1015/100 is 10.149999999999999 in binary floating point, and an implementation that divides
    // and stringifies sends them fifteen decimal places of a fee.
    expect(String(marketFeeFixedShekels(1500))).toBe('15');
    expect(String(marketFeeFixedShekels(1015))).toBe('10.15');
    expect(String(marketFeeFixedShekels(5))).toBe('0.05');
    expect(String(marketFeeFixedShekels(0))).toBe('0');
  });

  it('sends the price in agorot and the fixed fee in shekels, in the SAME request', async () => {
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'completed', sale_market_fee_total: 2100 });
    await generateSale({
      sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't1',
      marketFeePercent: 12, marketFeeFixedAgorot: 1500,
    }, CREDS);
    const body = lastBody();
    // The exact measured call: ₪50 sale, 12%, ₪15 fixed → sale_market_fee_total 2100.
    expect(body.sale_price).toBe(5000);   // agorot
    expect(body.market_fee).toBe(12);
    expect(body.market_fee_fixed).toBe(15);   // SHEKELS — 1500 would be read as ₪1,500
  });

  it('predicts the market fee PayMe actually reported on the measured sale', () => {
    // Measured: sale_price 5000, market_fee 12, market_fee_fixed 15 → sale_market_fee_total 2100.
    expect(marketFeeTotalAgorot({ salePriceAgorot: 5000, marketFeePercent: 12, marketFeeFixedAgorot: 1500 })).toBe(2100);
  });

  it('sends the fixed fee as `market_fee_fixed` — the name `direct_market_fee` is silently ignored', async () => {
    // PayMe called it "direct market fee" in writing to the owner, and that is their conversational
    // name, not the API's. Measured on two paid sandbox sales of ₪50: `market_fee_fixed: 15` came
    // back `sale_market_fee_total: 1500`; `direct_market_fee: 15` came back `0`.
    //
    // **This test exists because the failure is SILENT.** PayMe accept unknown parameters without
    // complaint, so a rename here — from their email, from a doc, from a plausible guess — is not a
    // build error and not a rejected call. It is a month of sales on which we took nothing.
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'completed' });
    await generateSale({
      sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't',
      marketFeePercent: 0, marketFeeFixedAgorot: 1500,
    }, CREDS);
    const body = lastBody();
    expect(body).toHaveProperty('market_fee_fixed', 15);
    expect(body).not.toHaveProperty('direct_market_fee');
  });

  it('keeps a market_fee of 0 instead of dropping it', async () => {
    // The shipping sale runs on OUR merchant account with no market fee at all. A truthiness test
    // here would omit the field and silently fall back to that merchant's default percentage —
    // i.e. we would take a cut of our own shipping charge and the arithmetic would stop closing.
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'completed' });
    await generateSale({ sellerPaymeId: 'MPL-US', salePriceAgorot: 3000, productName: 'משלוח', transactionId: 't2', marketFeePercent: 0 }, CREDS);
    expect(lastBody()).toHaveProperty('market_fee', 0);
  });
});

describe('minimums — 500 agorot for a sale and for a partial refund', () => {
  it('refuses a sale below the minimum before calling PayMe', async () => {
    await expect(generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 499, productName: 'x', transactionId: 't' }, CREDS))
      .rejects.toThrow(/below PayMe's minimum of 500/);
    // The point of checking locally: no request went out, so a doomed charge never becomes a
    // rejected one in the middle of a buyer's checkout.
    expect(net.calls).toHaveLength(0);
  });

  it('accepts a sale at exactly the minimum', async () => {
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'completed' });
    await expect(generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: PAYME_MIN_SALE_AGOROT, productName: 'x', transactionId: 't' }, CREDS))
      .resolves.toMatchObject({ paymeSaleId: 'S1' });
  });

  it('refuses a partial refund below the minimum', async () => {
    await expect(refundSale({ sellerPaymeId: 'MPL-A', paymeSaleId: 'S1', refundAmountAgorot: 499 }, CREDS))
      .rejects.toThrow(/below PayMe's minimum of 500/);
    expect(net.calls).toHaveLength(0);
  });

  it('lets a FULL refund through at any size — omitting the amount is what makes it full', async () => {
    // The trap this pins: a ₪3 order cannot be partially refunded, but it can be fully refunded,
    // because a full refund carries no amount at all. Clamping the amount to the minimum instead
    // would refund ₪5 of a ₪3 sale.
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'refunded' });
    await refundSale({ sellerPaymeId: 'MPL-A', paymeSaleId: 'S1' }, CREDS);
    expect(lastBody()).not.toHaveProperty('sale_refund_amount');
  });

  it('accepts a partial refund at exactly the minimum', async () => {
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'partial-refund' });
    await refundSale({ sellerPaymeId: 'MPL-A', paymeSaleId: 'S1', refundAmountAgorot: PAYME_MIN_REFUND_AGOROT }, CREDS);
    expect(lastBody().sale_refund_amount).toBe(500);
  });
});

describe('the 60% ceiling on our cut', () => {
  it('accepts a cut at the ceiling and refuses one past it', () => {
    // Exactly 60% of ₪50 is ₪30.
    expect(exceedsMarketFeeCeiling({ salePriceAgorot: 5000, marketFeePercent: 0, marketFeeFixedAgorot: 3000 })).toBe(false);
    expect(exceedsMarketFeeCeiling({ salePriceAgorot: 5000, marketFeePercent: 0, marketFeeFixedAgorot: 3001 })).toBe(true);
  });

  it('reproduces the measured refusal: ₪50 with a ₪30 delivery charge folded in is 72%', () => {
    // The exact case PayMe refused — `Market fee exceed allowed maximum of 60%`. 12% of ₪50 is ₪6,
    // plus ₪30 delivery is ₪36 of ₪50.
    expect(refuseSale({ salePriceAgorot: 5000, marketFeePercent: 12, marketFeeFixedAgorot: 3000 })).toBe('market-fee-ceiling');
  });

  it('reproduces the worse case: a cheap item with a real delivery charge', () => {
    // ₪10 + ₪30 delivery ≈ 87%. This is the shape that makes folding shipping into the seller's
    // sale unworkable, and the reason shipping is its own charge on our own account.
    expect(refuseSale({ salePriceAgorot: 1000, marketFeePercent: 12, marketFeeFixedAgorot: 3000 })).toBe('market-fee-ceiling');
  });

  it('a shipping charge on its OWN sale touches no ceiling', () => {
    // ₪30, our account, market_fee 0. The whole design point: this route was measured working.
    expect(refuseSale({ salePriceAgorot: 3000, marketFeePercent: 0 })).toBe(null);
  });

  it('an ordinary sale at the top commission tier is nowhere near the ceiling', () => {
    // 12% is `lib/pricing.ts`'s Starter commission — the highest one this platform charges.
    expect(refuseSale({ salePriceAgorot: 5000, marketFeePercent: 12 })).toBe(null);
    expect(PAYME_MAX_MARKET_FEE_PERCENT).toBe(60);
  });

  it('refuses a sale past the ceiling before calling PayMe', async () => {
    await expect(generateSale({
      sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't',
      marketFeePercent: 12, marketFeeFixedAgorot: 3000,
    }, CREDS)).rejects.toThrow(/exceeds 60%/);
    expect(net.calls).toHaveLength(0);
  });
});

describe('the buyer token — single-use unless permanent', () => {
  it('sends the expiry as ONE `credit_card_exp` field', async () => {
    // Measured: the obvious `credit_card_exp_month` + `credit_card_exp_year` pair — which is what
    // this sent until 2026-08-23 — is refused with `Required parameter is missing ·
    // credit_card_exp`. A loud failure, unlike the fee field above, and that is the whole
    // difference between a minute and a debugging session.
    net.replies.push({ status_code: 0, buyer_key: 'BK1' });
    await captureBuyerToken({ sellerPaymeId: 'MPL-A', creditCardNumber: '12312312', expiry: '1230', cvv: '123' }, CREDS);
    const body = lastBody();
    expect(body).toHaveProperty('credit_card_exp', '1230');
    expect(body).not.toHaveProperty('credit_card_exp_month');
    expect(body).not.toHaveProperty('credit_card_exp_year');
  });

  it('ALWAYS asks for a permanent token', async () => {
    // Measured: an ordinary token answers `Buyer inactive` on the second charge, so store one
    // succeeds and store two fails. There is no caller-facing switch for this, deliberately —
    // the plausible default is the one that breaks every multi-store cart.
    net.replies.push({ status_code: 0, buyer_key: 'BK1' });
    await captureBuyerToken({ sellerPaymeId: 'MPL-A', creditCardNumber: '12312312' }, CREDS);
    expect(lastBody().buyer_is_permanent).toBe(true);
  });

  it('charges the SAME token under a different seller — the multi-store mechanism', async () => {
    // Measured (§3.1.1 item 2): a token created under seller A charges successfully under seller B.
    net.replies.push({ status_code: 0, buyer_key: 'BK1' });
    const { buyerKey } = await captureBuyerToken({ sellerPaymeId: 'MPL-A', creditCardNumber: '12312312' }, CREDS);

    net.replies.push({ status_code: 0, payme_sale_id: 'S-A', sale_status: 'completed' });
    net.replies.push({ status_code: 0, payme_sale_id: 'S-B', sale_status: 'completed' });
    await generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'a', transactionId: 't1', buyerKey }, CREDS);
    await generateSale({ sellerPaymeId: 'MPL-B', salePriceAgorot: 5000, productName: 'b', transactionId: 't2', buyerKey }, CREDS);

    expect(net.calls[1]!.body.seller_payme_id).toBe('MPL-A');
    expect(net.calls[2]!.body.seller_payme_id).toBe('MPL-B');
    expect(net.calls[1]!.body.buyer_key).toBe('BK1');
    expect(net.calls[2]!.body.buyer_key).toBe('BK1');
  });

  it('surfaces `Buyer inactive` as a PayMe error rather than a success', async () => {
    // What a NON-permanent token does on its second charge. If this ever fires in production it
    // means the permanent flag stopped being sent, and the shape of the failure is store two of a
    // cart — so it must be loud, not a falsy return somebody forgets to check.
    net.replies.push({ status_code: 1, status_error_code: 511, status_error_details: 'Buyer inactive' });
    await expect(generateSale({ sellerPaymeId: 'MPL-B', salePriceAgorot: 5000, productName: 'b', transactionId: 't2', buyerKey: 'BK1' }, CREDS))
      .rejects.toThrow(/Buyer inactive/);
  });

  it('refuses to ask for a token while paying with one', async () => {
    await expect(generateSale({
      sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't',
      buyerKey: 'BK1', captureBuyer: true,
    }, CREDS)).rejects.toThrow(/cannot coexist/);
  });
});

describe('reading PayMe answers', () => {
  it('treats status_code, not the HTTP status, as the verdict', async () => {
    // Their refusals arrive under HTTP 500 with status_code 1, and their successes can arrive under
    // either. Reading `res.ok` would accept a refusal as a completed charge.
    net.httpStatus = 500;
    net.replies.push({ status_code: 0, payme_sale_id: 'S1', sale_status: 'completed' });
    await expect(generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't' }, CREDS))
      .resolves.toMatchObject({ paymeSaleId: 'S1' });

    net.httpStatus = 200;
    net.replies.push({ status_code: 1, status_error_code: 251, status_error_details: 'קישור משתמש לא נמצא' });
    await expect(generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't' }, CREDS))
      .rejects.toThrow(PaymeError);
  });

  it('names a non-existent endpoint rather than a JSON parse error', async () => {
    // An HTML body is how a wrong path answers (their endpoint-discovery behaviour). "unexpected
    // token <" sends whoever reads it looking in the wrong place.
    net.replies.push('<html>404</html>');
    await expect(generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't' }, CREDS))
      .rejects.toThrow(/endpoint may not exist/);
  });

  it('refuses a success that carries no id', async () => {
    // status_code 0 with no payme_sale_id is unusable: there would be nothing to refund against.
    net.replies.push({ status_code: 0, sale_status: 'completed' });
    await expect(generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't' }, CREDS))
      .rejects.toThrow(/without a payme_sale_id/);
  });

  it('carries PayMe\'s own error code so a caller can branch on it', async () => {
    net.replies.push({ status_code: 1, status_error_code: 305, status_error_details: 'Cannot perform action due to an incorrect status' });
    await generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't' }, CREDS)
      .then(() => expect.unreachable('should have thrown'))
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(PaymeError);
        expect((err as InstanceType<typeof PaymeError>).code).toBe(305);
      });
  });

  it('counts only `completed` as paid — an authorization is a hold, not money', () => {
    expect(saleIsPaid('completed')).toBe(true);
    expect(saleIsPaid('authorized')).toBe(false);
    expect(saleIsPaid('initial')).toBe(false);
    expect(saleIsPaid('failed')).toBe(false);
    expect(saleIsPaid('refunded')).toBe(false);
  });

  it('never puts the client key in a thrown message', async () => {
    net.replies.push({ status_code: 1, status_error_code: 9, status_error_details: 'nope' });
    await generateSale({ sellerPaymeId: 'MPL-A', salePriceAgorot: 5000, productName: 'x', transactionId: 't' }, CREDS)
      .catch((err: unknown) => expect(String(err)).not.toContain(CREDS.clientKey));
  });
});

describe('create-seller', () => {
  it('never sends our own seller_id — PayMe refuse it on this plan (790)', async () => {
    net.replies.push({ status_code: 0, seller_payme_id: 'MPL-NEW', seller_payme_secret: 'sec', seller_public_key: 'pub', seller_dashboard_signup_link: 'https://x', seller_approved: false });
    await createSeller(SELLER_INPUT, CREDS);
    expect(lastBody()).not.toHaveProperty('seller_id');
  });

  it('returns the four things the platform has to keep, and approval defaults to false', async () => {
    net.replies.push({
      status_code: 0, seller_payme_id: 'MPL-NEW', seller_payme_secret: 'sec',
      seller_public_key: 'pub', seller_dashboard_signup_link: 'https://onboarding',
    });
    const created = await createSeller(SELLER_INPUT, CREDS);
    expect(created).toEqual({
      sellerPaymeId: 'MPL-NEW', sellerPaymeSecret: 'sec', sellerPublicKey: 'pub',
      signupLink: 'https://onboarding', approved: false,
    });
    // A new merchant is `Restricted` until PayMe approve him (agreement §11). An absent field must
    // read as NOT approved: the alternative is a store that looks able to sell and cannot.
  });

  it('refuses a create that answers success without an id', async () => {
    net.replies.push({ status_code: 0, seller_payme_secret: 'sec' });
    await expect(createSeller(SELLER_INPUT, CREDS)).rejects.toThrow(/without a seller_payme_id/);
  });

  it('sets the seller\'s default market fee to our commission percent', async () => {
    net.replies.push({ status_code: 0, seller_payme_id: 'MPL-NEW' });
    await createSeller(SELLER_INPUT, CREDS);
    expect(lastBody().market_fee).toBe(12);
  });
});

describe('the callback signature', () => {
  const PARTS = { clientKey: 'CK', sellerSecret: 'SS', paymeTransactionId: 'TX', paymeSaleId: 'SALE' };

  it('is PayMe\'s documented md5(client_key + merchant_secret + transaction_id + sale_id)', async () => {
    const crypto = await import('node:crypto');
    const expected = crypto.createHash('md5').update('CKSSTXSALE').digest('hex');
    expect(callbackSignature(PARTS)).toBe(expected);
  });

  it('accepts the real signature and rejects everything else', () => {
    const sig = callbackSignature(PARTS);
    expect(verifyCallbackSignature({ ...PARTS, signature: sig })).toBe(true);
    expect(verifyCallbackSignature({ ...PARTS, signature: sig.toUpperCase() })).toBe(true);
    expect(verifyCallbackSignature({ ...PARTS, signature: 'x'.repeat(32) })).toBe(false);
    expect(verifyCallbackSignature({ ...PARTS, signature: '' })).toBe(false);
    expect(verifyCallbackSignature({ ...PARTS, signature: sig.slice(0, 31) })).toBe(false);
  });

  it('rejects when the sale or transaction id has been swapped', () => {
    // The attack this stops: a genuine signature from one sale replayed against another. Both ids
    // are inside the digest, so a forged pairing does not verify.
    const sig = callbackSignature(PARTS);
    expect(verifyCallbackSignature({ ...PARTS, paymeSaleId: 'OTHER', signature: sig })).toBe(false);
    expect(verifyCallbackSignature({ ...PARTS, paymeTransactionId: 'OTHER', signature: sig })).toBe(false);
  });

  it('rejects outright when the seller secret is missing', () => {
    // A seller whose secret failed to store would otherwise be verified against md5 of the empty
    // string — a formula anybody can compute — and would accept forged callbacks for every one of
    // his orders. Never falls back to "no secret, no check".
    const sig = callbackSignature({ ...PARTS, sellerSecret: '' });
    expect(verifyCallbackSignature({ ...PARTS, sellerSecret: '', signature: sig })).toBe(false);
  });
});

describe('environment', () => {
  it('knows the sandbox from the base URL we configured, never from an id', () => {
    expect(isSandbox(CREDS)).toBe(true);
    expect(isSandbox({ ...CREDS, baseUrl: 'https://live.payme.io/api/' })).toBe(false);
  });

  it('does NOT go live in development just because the sandbox keys are in .env', () => {
    // They are, on the developer's own machine. A credentials-only rule would mean every demo
    // purchase posts a real sale to a sandbox that is SHARED with PayMe's other partners and has no
    // delete — and would block the whole demo checkout on day one, since a seeded seller has no
    // merchant account and never will. In PRODUCTION the credentials ARE the whole switch, which is
    // the half `site-mode.ts` argues at length; these tests run with `import.meta.env.PROD` false,
    // so what they can pin is the dev half.
    const before = process.env.PAYME_CLIENT_KEY;
    const beforeGate = process.env.PAYME_DEV_LIVE;
    try {
      process.env.PAYME_CLIENT_KEY = 'ck';
      delete process.env.PAYME_DEV_LIVE;
      expect(paymeCredentials()).not.toBeNull();      // configured…
      expect(paymeIsActive()).toBe(false);            // …and deliberately not in use
      expect(activePaymeCredentials()).toBeNull();

      process.env.PAYME_DEV_LIVE = '1';
      expect(paymeIsActive()).toBe(true);
      // Only the exact value. 'true', 'yes' and '0' are all somebody being approximate about
      // sending real charges from a laptop.
      for (const nearly of ['true', 'yes', '0', '']) {
        process.env.PAYME_DEV_LIVE = nearly;
        expect(paymeIsActive(), nearly).toBe(false);
      }
    } finally {
      if (before === undefined) delete process.env.PAYME_CLIENT_KEY; else process.env.PAYME_CLIENT_KEY = before;
      if (beforeGate === undefined) delete process.env.PAYME_DEV_LIVE; else process.env.PAYME_DEV_LIVE = beforeGate;
    }
  });

  it('is inactive with no client key however the gate is set', () => {
    const before = process.env.PAYME_CLIENT_KEY;
    const beforeGate = process.env.PAYME_DEV_LIVE;
    try {
      delete process.env.PAYME_CLIENT_KEY;
      process.env.PAYME_DEV_LIVE = '1';
      expect(paymeIsActive()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.PAYME_CLIENT_KEY; else process.env.PAYME_CLIENT_KEY = before;
      if (beforeGate === undefined) delete process.env.PAYME_DEV_LIVE; else process.env.PAYME_DEV_LIVE = beforeGate;
    }
  });
});
