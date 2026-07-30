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
  /** The buyer's per-attempt idempotency key (lib/checkout-idempotency.ts), passed
   *  straight through to the gateway. Every real provider accepts one and will
   *  return the ORIGINAL transaction rather than charging again when it sees a
   *  repeat — a second line of defence behind our own ledger, for the window where
   *  the charge succeeded but recording it did not. Wiring it here now means the
   *  provider swap at go-live is still the one-line change this seam promises. */
  idempotencyKey: string;
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

/**
 * A buyer email that makes the mock provider DECLINE, so the failure path can
 * actually be walked before a real gateway exists.
 *
 * This is not a convenience. Until now the mock approved every charge, which meant
 * the entire decline branch — restoring reserved stock, releasing the idempotency
 * claim, journalling the rejection, showing the buyer the error — had never once
 * been executed outside a unit test. Code that has never run is not "working", it is
 * untested; and it is the branch that runs on the worst day.
 *
 * Modelled on how real gateways ship test cards (Stripe's 4000...0002, and the
 * Israeli providers' equivalents): an input that deterministically fails, so the
 * unhappy path is reachable on demand rather than only when something breaks. The
 * `+` form is a standard email sub-address, so one real inbox covers both cases —
 * `you+decline@gmail.com` fails, `you@gmail.com` succeeds, in the same session with
 * no restart and no config.
 */
export const MOCK_DECLINE_MARKER = '+decline@';

/** Dev/demo provider: approves every charge without touching a real gateway, so the full
 *  order flow works end-to-end with no company or merchant account. The MOCK- prefixed
 *  ref makes it obvious at a glance that a given order's payment wasn't real. */
class MockPaymentProvider implements PaymentProvider {
  async charge(req: PaymentRequest): Promise<PaymentResult> {
    // Guarded on DEV as well as on the marker. A production build must never be one
    // crafted email address away from a free "declined" checkout — and more to the
    // point, this whole class is meant to be gone by then (GO_LIVE_CHECKLIST §3).
    if (import.meta.env.DEV && req.buyerEmail.includes(MOCK_DECLINE_MARKER)) {
      return { ok: false, error: 'התשלום נדחה על ידי חברת האשראי. נסו כרטיס אחר.' };
    }
    return { ok: true, paymentRef: `MOCK-${req.checkoutRef}` };
  }
}

/** The single provider the app charges through. Swap this line for the real provider at
 *  go-live — every call site already goes through the PaymentProvider interface. */
export const paymentProvider: PaymentProvider = new MockPaymentProvider();
