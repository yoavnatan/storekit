/**
 * What the buyer may DO about a return, decided once.
 *
 * ── Why this is its own module ──
 *
 * The buyer's order card is rendered twice: by the server on first paint, and by a JS twin after any
 * search, page change or poll. That twin already cost us the return button once — it knew nothing
 * about returns, so the button vanished until a refresh (found by a parallel session, 2026-08-17), and
 * it is this repo's standing twin-renderer class (memory `project_client_renderer_i18n_drift`). The
 * offer buttons were about to repeat it exactly: they existed in the server's markup only, so a buyer
 * who searched his orders lost the only way to answer an offer.
 *
 * The fix is the one it always is here — the DECISION travels, and each renderer only draws. So this
 * returns button descriptors, never markup and never words: a `labelKey` each side looks up in its own
 * dictionary, because a Hebrew string written in a renderer is the drift
 * `i18n-hardcoded-strings.test.ts` refuses.
 */
import { canEscalate, type ReturnStatus } from './returns.js';
import { offersSelfPickup } from './shipping.js';
import type { Store } from './stores.js';

/**
 * Where the buyer may hand the product back over the counter, or `null` if nowhere.
 *
 * **The owner's rule (2026-08-17): a shop that offers collection in person MUST also accept returns in
 * person.** It is not a favour and it is not a setting — the seller already invites people to his
 * address to pick things up, so refusing to take one back there is refusing the easy half of a duty he
 * has anyway. It also removes the hardest dependency this mechanism has: an in-store handover needs no
 * carrier, no tracked label and no webhook, and the seller marks the parcel received with the buyer
 * standing in front of him. That is the strongest proof in the whole system, and it costs nothing.
 */
export function inStoreReturnAddress(store: Pick<Store, 'shipping' | 'address'> | null | undefined): string | null {
  return offersSelfPickup(store) ? (store?.address ?? null) : null;
}

/** The dictionary keys this module may name. Listed so a typo is a compile error rather than a blank
 *  button: both renderers index their own `t.buyerDashboard` / `I` with exactly these. */
export type ReturnCtaLabel =
  | 'offerAccept' | 'offerDecline'   // answering a partial-refund offer
  | 'returnSentBack'                 // "I sent the product back"
  | 'returnEscalate';                // "ask us to look at the refusal"

export interface ReturnCtaButton {
  /** The status this button asks for. `/api/returns` re-checks every one of them. */
  to: ReturnStatus;
  labelKey: ReturnCtaLabel;
}

export interface ReturnCta {
  /** The sentence above the buttons, when there is one. `offerHeading` carries the amount. */
  headingKey?: 'offerHeading' | 'returnSendHeading' | 'returnRejectedHeading';
  buttons: ReturnCtaButton[];
}

const NOTHING: ReturnCta = { buttons: [] };

/**
 * The buyer's move on this case, if he has one.
 *
 * Three states give him something to press, and each is a thing only he can know or claim:
 *
 *  · `offered` — the seller asked a question, so the buyer answers it. Accepting takes the smaller
 *    refund and keeps the goods; declining costs nothing and the ordinary return resumes.
 *  · `approved` — "I sent it back." Not proof of anything, and it refunds nobody: what it does is
 *    stop the day-7 expiry, which used to hand a silent seller the money AND the product.
 *  · `rejected` — asking us to look at the refusal, inside `ESCALATION_DAYS`. Past that the button is
 *    gone, and its absence is the answer: the case is finished and the money has moved.
 */
export function buyerReturnCta(
  rr: {
    status: ReturnStatus;
    partialOfferAgorot: number | null;
    settledAt: string | null;
  },
  todayISO?: string,
): ReturnCta {
  if (rr.status === 'offered') {
    // No amount, no offer to answer — the buttons would ask us to pay `null`.
    if (rr.partialOfferAgorot === null) return NOTHING;
    return {
      headingKey: 'offerHeading',
      buttons: [
        { to: 'refunded', labelKey: 'offerAccept' },
        { to: 'approved', labelKey: 'offerDecline' },
      ],
    };
  }
  if (rr.status === 'approved') {
    return { headingKey: 'returnSendHeading', buttons: [{ to: 'in_transit', labelKey: 'returnSentBack' }] };
  }
  if (canEscalate(rr.status, rr.settledAt, todayISO)) {
    return { headingKey: 'returnRejectedHeading', buttons: [{ to: 'disputed', labelKey: 'returnEscalate' }] };
  }
  return NOTHING;
}
