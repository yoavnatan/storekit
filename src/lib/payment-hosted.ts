/**
 * The seam for a gateway whose payment page the BUYER visits.
 *
 * `payment.ts` models the other kind — hand the server an amount, get a hold back, all inside one
 * request. Its header promised that swapping in a real provider would be "a one-line provider
 * swap", and that promise was written before anyone had read an Israeli gateway's documentation.
 * It is wrong for every provider we would actually pick: keeping this codebase out of PCI scope
 * means the card is entered on the provider's page, so the authorization happens between two of
 * our requests with a person in the middle. This interface is that shape, stated honestly, so the
 * checkout can be built against it once instead of against Hyp specifically.
 *
 * Three calls, and the split is not arbitrary — it is where the human is:
 *
 *   `startPayment`   → our server, before the buyer sees anything. Returns the URL to put in the
 *                      iframe. Nothing is held yet.
 *   `readReturn`     → our server, when the buyer comes back. Answers the only question that
 *                      matters: did the provider really authorize this, and for what.
 *   `capturePayment` → our server, after the orders exist. The irreversible step.
 *
 * **`readReturn` verifies with the PROVIDER; it never believes the browser.** The redirect arrives
 * as a query string the buyer can retype, so the parameters are evidence of nothing until the
 * provider confirms them. That check is inside the implementation rather than left to the caller,
 * because a caller that forgets it produces a checkout anyone can complete for free — and it would
 * pass every test that only ever sends honest input.
 *
 * The amount is deliberately NOT taken from the return: `capturePayment` is handed the figure the
 * caller read from its own record. The provider's answer says a payment happened; our row says
 * what was agreed, and those are different questions.
 */
import { hypCredentials, signPaymentPageRequest, verifyRedirect, fetchCardToken, captureAuthorization, cancelTransaction, HYP_AUTHORIZED } from './payment-hyp.js';

export interface StartPaymentRequest {
  /** The intent's id. Comes back to us on the redirect and is how we find the row again. */
  intentId: string;
  amountAgorot: number;
  buyerName?: string;
  buyerEmail?: string;
  /** Shown on the payment page and on the buyer's statement. */
  description: string;
  lang?: 'HEB' | 'ENG';
}

export interface StartedPayment {
  /** Where to point the iframe. */
  url: string;
}

/** What the provider said when the buyer came back. */
export type ReturnOutcome =
  /** The money is held. `providerRef` and `providerData` are what a capture will need. */
  | { status: 'authorized'; providerRef: string; providerData: Record<string, unknown> }
  /** The provider declined, or the buyer gave up. `reason` is safe to show. */
  | { status: 'declined'; reason: string }
  /** The parameters did not verify. Not a decline — a redirect we have no reason to believe. */
  | { status: 'unverified' };

export interface HostedPaymentProvider {
  /** A stable name for logs and for the intent's `provider_data`. */
  readonly name: string;
  startPayment(req: StartPaymentRequest): Promise<StartedPayment>;
  readReturn(params: URLSearchParams): Promise<ReturnOutcome>;
  /** Take `amountAgorot`, which must be ≤ what was authorized. */
  capturePayment(input: { providerRef: string; providerData: Record<string, unknown>; authorizedAgorot: number; amountAgorot: number; description: string }): Promise<{ ok: boolean; error?: string }>;
  /** Release a hold that will never be captured. */
  releaseHold(input: { providerRef: string }): Promise<{ ok: boolean }>;
}

/**
 * Hyp Pay.
 *
 * The mapping onto `payment-hyp.ts` is one-to-one except in one place worth naming: the card token
 * is fetched during CAPTURE and not on return. It could be fetched either side, and doing it at
 * capture time keeps the token's life as short as possible — it exists for the duration of one
 * server call rather than sitting in a database row between two requests.
 */
class HypHostedProvider implements HostedPaymentProvider {
  readonly name = 'hyp';

  async startPayment(req: StartPaymentRequest): Promise<StartedPayment> {
    const creds = hypCredentials();
    if (!creds) throw new Error('hyp: credentials are not configured');
    const { url } = await signPaymentPageRequest({
      amountAgorot: req.amountAgorot,
      // Our intent id, which Hyp echo back as `Order`. This is the whole of the link between the
      // page the buyer is looking at and the row that says what they agreed to.
      orderRef: req.intentId,
      description: req.description,
      ...(req.buyerName ? { buyerName: req.buyerName } : {}),
      ...(req.buyerEmail ? { buyerEmail: req.buyerEmail } : {}),
      ...(req.lang ? { lang: req.lang } : {}),
    }, creds);
    return { url };
  }

  async readReturn(params: URLSearchParams): Promise<ReturnOutcome> {
    const creds = hypCredentials();
    if (!creds) throw new Error('hyp: credentials are not configured');

    // Ask Hyp first, and answer nothing else if they say no. A `CCode` in the query string is a
    // claim by whoever loaded the URL until this returns true.
    if (!await verifyRedirect([...params.entries()], creds)) return { status: 'unverified' };

    const code = params.get('CCode') ?? '';
    // 700, not 0 — a J5 authorization has its own success code, and treating only 0 as success
    // rejects every good payment (payment-hyp.ts's header).
    if (code !== HYP_AUTHORIZED) {
      return { status: 'declined', reason: `CCode=${code || '—'}` };
    }

    const transId = params.get('Id') ?? '';
    const authCode = params.get('ACode') ?? '';
    const uid = params.get('UID') ?? '';
    // Verified and yet incomplete: `MoreData=True` is what puts UID on the redirect, so its absence
    // means the payment page was built without it and no capture is possible. Loud, because the
    // money IS held at this point and silently treating it as a decline would strand it.
    if (!transId || !authCode || !uid) {
      throw new Error(`hyp: authorized but the redirect is missing capture data (Id=${!!transId} ACode=${!!authCode} UID=${!!uid})`);
    }

    return {
      status: 'authorized',
      providerRef: transId,
      providerData: { authCode, uid, buyerIsraeliId: params.get('UserId') ?? '', provider: 'hyp' },
    };
  }

  async capturePayment(input: { providerRef: string; providerData: Record<string, unknown>; authorizedAgorot: number; amountAgorot: number; description: string }): Promise<{ ok: boolean; error?: string }> {
    const creds = hypCredentials();
    if (!creds) throw new Error('hyp: credentials are not configured');
    try {
      const { token, expiry } = await fetchCardToken(input.providerRef, creds);
      await captureAuthorization({
        authCode: String(input.providerData.authCode ?? ''),
        originalUid: String(input.providerData.uid ?? ''),
        buyerIsraeliId: String(input.providerData.buyerIsraeliId ?? '') || undefined,
        token,
        tokenExpiry: expiry,
        authorizedAgorot: input.authorizedAgorot,
        captureAgorot: input.amountAgorot,
        description: input.description,
      }, creds);
      return { ok: true };
    } catch (err) {
      // The message carries Hyp's CCode and no credentials (`maskCredentials` guards the URL), so
      // it is safe to journal. It is NOT safe to show a buyer, and no caller should.
      return { ok: false, error: err instanceof Error ? err.message : 'capture failed' };
    }
  }

  async releaseHold(input: { providerRef: string }): Promise<{ ok: boolean }> {
    const creds = hypCredentials();
    if (!creds) throw new Error('hyp: credentials are not configured');
    const { cancelled } = await cancelTransaction(input.providerRef, creds);
    // `false` here is Hyp saying the transaction was already transmitted — the money is real and
    // the caller owes a refund rather than a retry. It is reported, never swallowed.
    return { ok: cancelled };
  }
}

/**
 * The provider the checkout will use, or null when none is configured.
 *
 * Null is a real answer and not a failure: with no gateway configured the site runs on
 * `MockPaymentProvider` exactly as it does today, and `site-mode.ts` already derives "this
 * deployment cannot take money" from that rather than from a flag. Deriving it from the presence
 * of credentials means a production server can never be one forgotten switch away from a free
 * checkout.
 */
export function hostedPaymentProvider(): HostedPaymentProvider | null {
  return hypCredentials() ? new HypHostedProvider() : null;
}
