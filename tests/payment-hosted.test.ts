/**
 * The hosted-payment seam — the rules that make a redirect safe to act on.
 *
 * Every case here is a way a checkout built on a hosted payment page gives goods away or takes the
 * wrong amount, and each is a rule the module enforces rather than a behaviour it happens to have:
 *
 *  · the redirect is a query string the buyer can retype, so it is worth nothing until the
 *    PROVIDER confirms it — and that check must be impossible for a caller to skip;
 *  · a J5 authorization answers 700, so code that knows only 0 rejects every good payment;
 *  · a verified authorization missing its capture data is LOUD, because the money is already held;
 *  · the amount captured comes from our record, never from what came back with the buyer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hyp = vi.hoisted(() => ({
  creds: { masof: '0010131918', key: 'k', passp: 'p', baseUrl: 'https://pay.hyp.co.il/p/' } as unknown,
  verified: true,
  signed: { url: 'https://pay.hyp.co.il/p/?signed=1' },
  token: { token: 'tok', expiry: '3105' },
  captureThrows: null as Error | null,
  captures: [] as Record<string, unknown>[],
  cancelled: true,
}));

vi.mock('../src/lib/payment-hyp.js', () => ({
  hypCredentials: () => hyp.creds,
  signPaymentPageRequest: async (req: Record<string, unknown>) => { hyp.captures.push({ signed: req }); return hyp.signed; },
  verifyRedirect: async () => hyp.verified,
  fetchCardToken: async () => hyp.token,
  captureAuthorization: async (cap: Record<string, unknown>) => {
    if (hyp.captureThrows) throw hyp.captureThrows;
    hyp.captures.push(cap);
    return { CCode: '0' };
  },
  cancelTransaction: async () => ({ cancelled: hyp.cancelled, code: hyp.cancelled ? '0' : '920' }),
  HYP_AUTHORIZED: '700',
}));

const { hostedPaymentProvider } = await import('../src/lib/payment-hosted.js');

function authorizedReturn(over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ CCode: '700', Id: '401594866', ACode: '0463077', UID: 'uid-1', UserId: '890108558', ...over });
}

beforeEach(() => {
  hyp.creds = { masof: '0010131918', key: 'k', passp: 'p', baseUrl: 'https://pay.hyp.co.il/p/' };
  hyp.verified = true;
  hyp.captureThrows = null;
  hyp.captures = [];
  hyp.cancelled = true;
});

describe('choosing a provider', () => {
  it('is null when no gateway is configured, so the mock keeps the site honest', () => {
    // `site-mode.ts` derives "this deployment cannot take money" from the provider rather than
    // from a flag. A production server must never be one forgotten switch from a free checkout.
    hyp.creds = null;
    expect(hostedPaymentProvider()).toBeNull();
  });

  it('is Hyp when credentials exist', () => {
    expect(hostedPaymentProvider()?.name).toBe('hyp');
  });
});

describe('starting a payment', () => {
  it('sends the intent id as the reference the provider will echo back', async () => {
    await hostedPaymentProvider()!.startPayment({ intentId: 'intent-1', amountAgorot: 5000, description: 'cart' });
    expect((hyp.captures[0] as { signed: Record<string, unknown> }).signed.orderRef).toBe('intent-1');
    expect((hyp.captures[0] as { signed: Record<string, unknown> }).signed.amountAgorot).toBe(5000);
  });
});

describe('reading the return', () => {
  it('accepts an authorization the provider confirms', async () => {
    const outcome = await hostedPaymentProvider()!.readReturn(authorizedReturn());
    expect(outcome).toEqual({
      status: 'authorized',
      providerRef: '401594866',
      providerData: { authCode: '0463077', uid: 'uid-1', buyerIsraeliId: '890108558', provider: 'hyp' },
    });
  });

  it('refuses a redirect the provider does not recognise, however well-formed', async () => {
    // The whole attack: type CCode=700 into the URL and finish a checkout for free. Every field
    // below is perfect; only the provider's answer is missing.
    hyp.verified = false;
    expect(await hostedPaymentProvider()!.readReturn(authorizedReturn())).toEqual({ status: 'unverified' });
  });

  it('checks with the provider BEFORE reading anything out of the parameters', async () => {
    // Ordering matters: a module that parsed first and verified second would still be correct
    // here, but the shape invites a future edit that returns early on a parse failure and never
    // reaches the verification at all.
    hyp.verified = false;
    expect(await hostedPaymentProvider()!.readReturn(new URLSearchParams({ CCode: '700' }))).toEqual({ status: 'unverified' });
  });

  it('reports a decline as a decline, not as a forgery', async () => {
    const outcome = await hostedPaymentProvider()!.readReturn(authorizedReturn({ CCode: '033' }));
    expect(outcome).toEqual({ status: 'declined', reason: 'CCode=033' });
  });

  it('does not mistake an ordinary charge code for an authorization', async () => {
    // 0 means a completed charge, which this flow never asks for. Accepting it would mean treating
    // "already taken" as "held", and the capture that followed would double-charge.
    expect((await hostedPaymentProvider()!.readReturn(authorizedReturn({ CCode: '0' }))).status).toBe('declined');
  });

  it('throws when a VERIFIED authorization has no capture data — the money is already held', async () => {
    // MoreData=True is what puts UID on the redirect. Without it the funds are reserved on a real
    // card and nothing can ever capture or release them, so this must not be quietly a decline.
    await expect(hostedPaymentProvider()!.readReturn(authorizedReturn({ UID: '' })))
      .rejects.toThrow(/missing capture data/);
  });
});

describe('capturing', () => {
  it('captures the amount it was given, and passes the authorized amount separately', async () => {
    // The two are different numbers on purpose — the caller may take less than was held — and Hyp
    // want them in different units, which is the trap `payment-hyp.ts` exists to hold.
    await hostedPaymentProvider()!.capturePayment({
      providerRef: '401594866',
      providerData: { authCode: 'a', uid: 'u', buyerIsraeliId: '890108558' },
      authorizedAgorot: 5000,
      amountAgorot: 4200,
      description: 'order',
    });
    const cap = hyp.captures[0] as Record<string, unknown>;
    expect(cap.authorizedAgorot).toBe(5000);
    expect(cap.captureAgorot).toBe(4200);
    expect(cap.token).toBe('tok');
    expect(cap.tokenExpiry).toBe('3105');
  });

  it('reports a refusal instead of throwing, so the caller can void and restock', async () => {
    hyp.captureThrows = new Error('hyp: capture refused (CCode=033)');
    const result = await hostedPaymentProvider()!.capturePayment({
      providerRef: 'r', providerData: {}, authorizedAgorot: 100, amountAgorot: 100, description: 'd',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/CCode=033/);
  });
});

describe('releasing a hold', () => {
  it('reports success', async () => {
    expect(await hostedPaymentProvider()!.releaseHold({ providerRef: 'r' })).toEqual({ ok: true });
  });

  it('reports failure rather than pretending the money came back', async () => {
    // Hyp answering 920 means the transaction was already transmitted: the charge is real and the
    // caller owes a refund. Returning ok here would leave a buyer charged for a cancelled order.
    hyp.cancelled = false;
    expect(await hostedPaymentProvider()!.releaseHold({ providerRef: 'r' })).toEqual({ ok: false });
  });
});
