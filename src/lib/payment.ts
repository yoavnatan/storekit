// Payment abstraction — the single seam the checkout charges through. Swapping the real
// gateway in later (a local provider like PayPlus/Grow, once a company + clearing
// agreement exist) is a one-line provider swap HERE, never a rewrite of the checkout
// flow. Israeli card clearing runs through SHVA, which Stripe can't reach — so the
// production provider will be a local one, wired in behind this same interface.

export interface PaymentRequest {
  /** Grand total across all stores in the checkout, in ILS. */
  amount: number;
  /** Shared reference tying the (possibly multi-store) purchase together. */
  checkoutRef: string;
  buyerEmail: string;
}

export interface PaymentResult {
  ok: boolean;
  /** Gateway transaction id — stored on the order as paymentRef. */
  paymentRef?: string;
  /** Buyer-facing reason when ok is false. */
  error?: string;
}

export interface PaymentProvider {
  charge(req: PaymentRequest): Promise<PaymentResult>;
}

/** Dev/demo provider: approves every charge without touching a real gateway, so the full
 *  order flow works end-to-end with no company or merchant account. The MOCK- prefixed
 *  ref makes it obvious at a glance that a given order's payment wasn't real. */
class MockPaymentProvider implements PaymentProvider {
  async charge(req: PaymentRequest): Promise<PaymentResult> {
    return { ok: true, paymentRef: `MOCK-${req.checkoutRef}` };
  }
}

/** The single provider the app charges through. Swap this line for the real provider at
 *  go-live — every call site already goes through the PaymentProvider interface. */
export const paymentProvider: PaymentProvider = new MockPaymentProvider();
