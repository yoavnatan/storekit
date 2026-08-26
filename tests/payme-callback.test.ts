/**
 * PayMe's callback endpoint — a PUBLIC URL, so every case here is somebody who is not PayMe.
 *
 * The URL has to be public: PayMe refuse a localhost callback URL. So this endpoint is reachable by
 * anyone who finds it, and the only question worth testing is what a stranger can make it do.
 *
 *  · A seller notification carries NO signature (their spec has no such field on it), so nothing in
 *    its body may be written — the truth is fetched over our own authenticated call.
 *  · A sale notification carries one, and an unverified body must change nothing and be LOUD.
 *  · Neither may ever move an order's payment status. A public URL that can mark orders paid is a
 *    free checkout for whoever finds it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  account: null as null | { sellerId: string; providerRef: string; approved: boolean; active: boolean },
  secret: null as string | null,
  upstream: null as null | { approved: boolean; active: boolean },
  upstreamThrows: false,
  approvalWrites: [] as { providerRef: string; approved: boolean; active: boolean }[],
  moneyEvents: [] as Record<string, unknown>[],
  errors: [] as Record<string, unknown>[],
  credsConfigured: true,
}));

vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantAccountByProviderRef: async (ref: string) =>
    state.account && state.account.providerRef === ref ? state.account : null,
  merchantCallbackSecret: async () => state.secret,
  setMerchantApproval: async (providerRef: string, approved: boolean, active = true) => {
    state.approvalWrites.push({ providerRef, approved, active });
  },
}));

vi.mock('../src/lib/money-events.js', () => ({
  recordMoneyEvent: async (event: Record<string, unknown>) => { state.moneyEvents.push(event); },
}));

vi.mock('../src/lib/error-log.js', () => ({
  logError: async (entry: Record<string, unknown>) => { state.errors.push(entry); },
}));

vi.mock('../src/lib/payment-payme.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/payment-payme.js')>();
  return {
    ...actual,
    activePaymeCredentials: () => (state.credsConfigured ? { clientKey: 'CK', baseUrl: 'https://sandbox.payme.io/api/' } : null),
    getSellerStatus: async () => {
      if (state.upstreamThrows) throw new Error('network down');
      return state.upstream;
    },
  };
});

const { POST } = await import('../src/pages/api/payme/callback.js');
const { callbackSignature } = await import('../src/lib/payment-payme.js');

function post(fields: Record<string, string>): Promise<Response> {
  return POST({
    request: new Request('https://dezabin.co.il/api/payme/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  } as never);
}

async function received(res: Response): Promise<string> {
  return ((await res.json()) as { received: string }).received;
}

beforeEach(() => {
  state.account = { sellerId: '11111111-1111-4111-8111-111111111111', providerRef: 'MPL-A', approved: false, active: true };
  state.secret = 'SELLER-SECRET';
  state.upstream = { approved: true, active: true };
  state.upstreamThrows = false;
  state.approvalWrites = [];
  state.moneyEvents = [];
  state.errors = [];
  state.credsConfigured = true;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('always answers 200', () => {
  it('even when it refuses the body', async () => {
    // PayMe retry anything that is not a 200, and retrying something we deliberately refused buys
    // nobody anything. The refusal lives in the LOG; the status code is just politeness.
    const bodies: Record<string, string>[] = [{}, { notify_type: 'nonsense' }, { notify_type: 'sale-complete' }];
    for (const fields of bodies) {
      expect((await post(fields)).status, JSON.stringify(fields)).toBe(200);
    }
  });
});

describe('seller notifications — no signature, so nothing in the body is believed', () => {
  it('does NOT take approval from the request, however confidently it claims it', async () => {
    // The attack: a stranger posts `seller_approved=1` and unblocks a store. Their spec's seller
    // callback has no signature field at all, so this is the only thing standing in the way.
    state.upstream = { approved: false, active: true };
    await post({ notify_type: 'seller-update', seller_payme_id: 'MPL-A', seller_approved: '1' });
    // What was written is what PayMe told US over our own call — nothing, because their answer
    // (`approved: false, active: true`) is exactly what is already stored. The body shouted
    // `seller_approved=1` and moved nothing at all.
    expect(state.approvalWrites).toEqual([]);
  });

  it('writes approval that our OWN authenticated call confirms', async () => {
    state.upstream = { approved: true, active: true };
    expect(await received(await post({ notify_type: 'seller-create', seller_payme_id: 'MPL-A' }))).toBe('seller-updated');
    expect(state.approvalWrites).toEqual([{ providerRef: 'MPL-A', approved: true, active: true }]);
  });

  it('treats an approved-but-INACTIVE merchant as unable to sell', async () => {
    // He cannot take money either way, and calling him sellable would produce a refused charge in
    // the middle of a buyer's checkout instead of a store that says why.
    // ── The two flags travel SEPARATELY since 2026-08-26 (owner, סשן א׳ §20) ──
    // They used to be folded into one boolean here, and that is exactly why a refusal was
    // indistinguishable from a review that had not finished: the seller's screen said "up to seven
    // business days" for ever. `approved` is still their approval; `active: false` is the refusal,
    // and it is what `clearingStatusFor` turns into a `rejected` state and what raises the
    // error-log row a person reads.
    state.upstream = { approved: true, active: false };
    await post({ notify_type: 'seller-create', seller_payme_id: 'MPL-A' });
    expect(state.approvalWrites).toEqual([{ providerRef: 'MPL-A', approved: true, active: false }]);
  });

  it('never turns a failed lookup into a verdict', async () => {
    // Null from `get-sellers` means "PayMe do not know him", which is NOT "not approved". Writing
    // false here would close a working seller's shop because a query came back empty.
    state.account = { sellerId: '11111111-1111-4111-8111-111111111111', providerRef: 'MPL-A', approved: true, active: true };
    state.upstream = null;
    expect(await received(await post({ notify_type: 'seller-create', seller_payme_id: 'MPL-A' }))).toBe('seller-not-found-upstream');
    expect(state.approvalWrites).toEqual([]);
  });

  it('leaves the stored status alone when the lookup fails, and says so where a person will read it', async () => {
    state.upstreamThrows = true;
    expect(await received(await post({ notify_type: 'seller-create', seller_payme_id: 'MPL-A' }))).toBe('lookup-failed');
    expect(state.approvalWrites).toEqual([]);
    expect(state.errors).toHaveLength(1);
  });

  it('ignores a merchant we have never heard of', async () => {
    // The sandbox is shared with PayMe's other partners — 13 merchants were in it before we
    // touched it — so this is ordinary there and evidence of nothing.
    expect(await received(await post({ notify_type: 'seller-create', seller_payme_id: 'MPL-STRANGER' }))).toBe('unknown-seller');
    expect(state.approvalWrites).toEqual([]);
  });
});

describe('sale notifications — verified, journalled, and powerless over an order', () => {
  const SALE = { notify_type: 'sale-complete', seller_payme_id: 'MPL-A', payme_sale_id: 'S1', payme_transaction_id: 'T1', price: '5000', sale_status: 'completed' };
  const signed = () => callbackSignature({ clientKey: 'CK', sellerSecret: 'SELLER-SECRET', paymeTransactionId: 'T1', paymeSaleId: 'S1' });

  it('records a correctly signed one', async () => {
    expect(await received(await post({ ...SALE, payme_signature: signed() }))).toBe('sale-recorded');
    expect(state.moneyEvents).toHaveLength(1);
    expect(state.moneyEvents[0]).toMatchObject({ type: 'payment_attempted', amountAgorot: 5000, actor: 'system' });
  });

  it('refuses an unsigned one and records nothing', async () => {
    expect(await received(await post(SALE))).toBe('bad-signature');
    expect(state.moneyEvents).toEqual([]);
  });

  it('refuses a forged one and makes it LOUD', async () => {
    // Two very different things land here — a stranger, and a correct callback whose signature we
    // compute wrongly because the formula was read in their docs and never measured against a real
    // callback. Only a person reading the log can tell them apart, which is why this is an alert
    // and not a silent drop.
    expect(await received(await post({ ...SALE, payme_signature: 'f'.repeat(32) }))).toBe('bad-signature');
    expect(state.errors).toHaveLength(1);
    expect(String(state.errors[0]!.message)).toContain('signature');
  });

  it('refuses a signature that is genuine for a DIFFERENT sale', async () => {
    // Replaying one sale's callback against another. Both ids are inside the digest, so the
    // forged pairing does not verify.
    expect(await received(await post({ ...SALE, payme_sale_id: 'S2', payme_signature: signed() }))).toBe('bad-signature');
  });

  it('refuses when we hold no secret for that merchant, rather than verifying against nothing', async () => {
    // md5 of the empty secret is a digest anybody can compute. A seller whose secret failed to
    // store must not become the one seller whose callbacks anyone can forge.
    state.secret = null;
    expect(await received(await post({ ...SALE, payme_signature: signed() }))).toBe('bad-signature');
  });

  it('files a refund under its own journal word', async () => {
    await post({ ...SALE, notify_type: 'refund', sale_status: 'refunded', payme_signature: signed() });
    expect(state.moneyEvents[0]).toMatchObject({ type: 'refund_settled' });
  });

  it('never writes an order status — the charge already completed synchronously', async () => {
    // A public URL that can mark an order paid is a free checkout for whoever finds it. This
    // endpoint corroborates; it does not decide. The proof is structural: the route imports nothing
    // that can write an order.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/pages/api/payme/callback.ts', 'utf8'));
    expect(src).not.toMatch(/updateOrder|createOrder|markOrdersPaid/);
  });
});

describe('when PayMe are not configured', () => {
  it('answers politely instead of acting or 404-ing', async () => {
    state.credsConfigured = false;
    expect(await received(await post({ notify_type: 'seller-create', seller_payme_id: 'MPL-A' }))).toBe('not-configured');
    expect(state.approvalWrites).toEqual([]);
  });
});
