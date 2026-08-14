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

/**
 * ── AUTHORIZE → ORDER → CAPTURE, and the reason it is not one `charge()` call ──
 *
 * The owner's rule, 2026-08-07, and it is the correct one: **an order may exist only if money was
 * really taken, and money may be taken only if the order really exists.** A single `charge()` call
 * cannot give that. Money and our database are two systems, and no transaction spans both — so
 * whichever one you commit first, there is a window where it is done and the other is not, and
 * something in that window WILL fail eventually.
 *
 * What removes the window is not a bigger transaction, it is making the first step REVERSIBLE and
 * the irreversible step LAST:
 *
 *   1. `authorize` — the gateway HOLDS the amount on the buyer's card. Nothing has been taken; the
 *      buyer may see a pending line, and it disappears by itself if we never capture.
 *   2. the order rows are written, in one database transaction.
 *   3. `capture` — only now is the money actually moved, and by then the order provably exists.
 *
 * Every failure then lands somewhere harmless:
 *   · authorize declines            → no hold, no order. Nothing to undo.
 *   · the order write throws        → `voidCharge` releases the hold. The buyer was never charged.
 *   · capture fails                 → the hold is released and the orders that were written are
 *                                     marked failed/cancelled and their stock returned. The record
 *                                     survives as evidence — money rows are never deleted — but no
 *                                     money moved and nothing is shippable.
 *
 * This is what the flow used to be, and why it was wrong: it charged first and wrote orders second,
 * so a throw in between was a completed charge with no order behind it. It was not theoretical.
 * A UNIQUE constraint on `payment_ref` made the order INSERT fail on EVERY multi-store cart
 * (migration 0017); against the mock nothing moved and it merely produced an alarming alert, but
 * against a real gateway every one of those would have been a live charge for an order that does
 * not exist, with no confirmation mail and nothing the buyer could point at.
 *
 * **Authorize/Capture is a hard requirement on the provider, not a preference.** CURRENT_TASK §א.1
 * already has to verify it for the ad-budget hold; this is the second and more important reason.
 * A provider that cannot authorize separately from capture cannot make the owner's rule true, and
 * that now counts against choosing it.
 */
export interface VoidRequest {
  /** The authorization to release, as `authorize` returned it. */
  paymentRef: string;
  /** Same key the authorization carried, so a provider that de-duplicates sees the pair. */
  idempotencyKey: string;
  amount: number;
  /** Why, for the provider's own record and for ours. */
  reason: string;
}

export interface VoidResult {
  ok: boolean;
  error?: string;
}

export interface CaptureRequest {
  /** The authorization to draw on. */
  paymentRef: string;
  idempotencyKey: string;
  /** What to actually take. Never more than was authorized. */
  amount: number;
}

export interface CaptureResult {
  ok: boolean;
  /** Buyer-facing reason when ok is false. */
  error?: string;
}

export interface PaymentProvider {
  /** Place a HOLD for `amount`. Takes nothing. Returns the transaction to capture or void. */
  authorize(req: PaymentRequest): Promise<PaymentResult>;
  /** Move the held money. The irreversible step, and it runs only after the order rows exist. */
  capture(req: CaptureRequest): Promise<CaptureResult>;
  /** Release a hold that will never be captured. See the header above. */
  voidCharge(req: VoidRequest): Promise<VoidResult>;
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
/** Exported so `lib/site-mode.ts` can ask the live provider whether it is this one, rather than
 *  comparing a name or trusting a flag. That check is what closes the shop on a production server
 *  with no gateway wired — see the file header there for why it is derived and not switched. */
export class MockPaymentProvider implements PaymentProvider {
  async authorize(req: PaymentRequest): Promise<PaymentResult> {
    // Guarded on DEV as well as on the marker. A production build must never be one
    // crafted email address away from a free "declined" checkout — and more to the
    // point, this whole class is meant to be gone by then (GO_LIVE_CHECKLIST §3).
    if (import.meta.env.DEV && req.buyerEmail.includes(MOCK_DECLINE_MARKER)) {
      return { ok: false, error: 'התשלום נדחה על ידי חברת האשראי. נסו כרטיס אחר.' };
    }
    return { ok: true, paymentRef: `MOCK-${req.checkoutRef}` };
  }

  /** The mock holds nothing, so capture always succeeds — but it EXISTS, and the checkout calls it
   *  in the right place, so the ordering this seam exists to enforce is exercised on every dev
   *  purchase rather than first meeting reality on the day a real gateway is wired in. */
  async capture(_req: CaptureRequest): Promise<CaptureResult> {
    return { ok: true };
  }

  /** Nothing was held, so nothing is released — but it answers `ok` rather than throwing, so the
   *  caller's compensation path runs end to end in dev exactly as it will in production. A branch
   *  that only ever executes against the real gateway is a branch nobody has tested. */
  async voidCharge(_req: VoidRequest): Promise<VoidResult> {
    return { ok: true };
  }
}

/** The single provider the app charges through. Swap this line for the real provider at
 *  go-live — every call site already goes through the PaymentProvider interface. */
export const paymentProvider: PaymentProvider = new MockPaymentProvider();
