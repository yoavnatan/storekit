// Delivery/shipping model — platform-provided. Prices are PLATFORM-set (SHIPPING_RATES
// below), never per-seller: a store receives shipping as a service through us and does
// not profit from it. The seller's only lever is whether to also offer self-pickup from
// the store address. Pure/isomorphic (no node:fs) so the checkout server route and the
// browser-bundled checkout script import the same single source of truth — mirror of how
// variant-combo.ts is shared across both sides.

export type DeliveryMethod = 'pickup' | 'courier' | 'pickup_point';

/** Platform shipping rates in ILS — central, identical for every store. Change here to
 *  change it everywhere. Self-pickup is always free and never appears here.
 *
 *  **These two numbers are placeholders, not chosen prices** (owner, 2026-08-09), and the rule
 *  that will replace them is already fixed: **the platform does not absorb shipping cost.** The
 *  carrier quoted a tariff that varies by pickup locality and destination, so whatever lands here
 *  must cover the real cost — either one number high enough for the expensive case, or a function
 *  of destination. A function is allowed: "platform-set" means the seller never prices shipping
 *  or profits from it, not that there is exactly one number. What it would cost elsewhere —
 *  chiefly `offerShippingDetails()` below, which publishes a single figure to Merchant Center —
 *  is worked out in GO_LIVE §5.0.3, and no number moves before their rate table arrives.
 *
 *  **These numbers INCLUDE VAT; a carrier's tariff does not. Compare net to net or the
 *  comparison lies (2026-08-25).** This is a consumer-facing price, so 18% of it is never ours:
 *  ₪30 leaves us ₪25.42 and ₪20 leaves ₪16.95. A ₪28 tariff therefore loses ₪2.58 per parcel
 *  while reading as a ₪2 margin — the whole gap §5.0.3 has to place is 18% wider than it looks.
 *  Whoever replaces these placeholders divides by 1.18 first. Why it nets to zero for income
 *  tax, and the six questions for the accountant: `docs/shipping-tax-brief.md`. */
export const SHIPPING_RATES = {
  courier: 30,
  pickup_point: 20,
} as const;

/**
 * Does this shop really offer collection in person?
 *
 * Two halves, and both are required: the seller opted in, AND the store has an address to collect
 * from. It was written out by hand at three call sites — the checkout page, `/api/checkout`, and then
 * the returns card — and the third is what made it a function: a fourth surface disagreeing about
 * whether a shop offers pickup is a buyer told he may collect from an address we do not hold.
 *
 * `addressVisible` deliberately does NOT gate it. Offering collection publishes the address by
 * necessity — you cannot come to a place you are not told — so that flag governs the shop's about
 * panel, not this.
 *
 * The parameter is shaped structurally rather than typed as a `Store`, which keeps this file what its
 * header promises: pure, importable from the browser bundle and from a test, with no store model and
 * no database behind it. That matters here specifically — a DB-backed home would force every test
 * that mocks the store module to restate the rule, and a restated rule is the bug.
 */
export function offersSelfPickup(
  store: { shipping?: { selfPickup?: boolean }; address?: string } | null | undefined,
): boolean {
  return !!store?.shipping?.selfPickup && !!store.address;
}

/** Courier + pickup point are platform defaults available on every store. Self-pickup is
 *  offered only when the seller opted in AND the store has a pickup address — the caller
 *  passes that already-resolved boolean (address presence is checked where the Store is
 *  in scope, keeping this file free of the fs-backed store model). */
export function availableDeliveryMethods(offersSelfPickup: boolean): DeliveryMethod[] {
  return offersSelfPickup ? ['pickup', 'courier', 'pickup_point'] : ['courier', 'pickup_point'];
}

/** Price for a method — self-pickup is always free; the rest use the central rate. */
export function shippingPrice(method: DeliveryMethod): number {
  return method === 'pickup' ? 0 : SHIPPING_RATES[method];
}

/** Server-side guard: never trust the client's chosen method — confirm the store actually
 *  offers it (mirrors the price re-validation rule in checkout). An unknown or unavailable
 *  method falls back to courier, a universally-available PAID method, so a spoofed value
 *  can never zero out shipping. */
export function normalizeDeliveryMethod(method: unknown, offersSelfPickup: boolean): DeliveryMethod {
  const allowed = availableDeliveryMethods(offersSelfPickup) as string[];
  return typeof method === 'string' && allowed.includes(method) ? (method as DeliveryMethod) : 'courier';
}

/**
 * schema.org `OfferShippingDetails` for a product offer — what Google's merchant-listing
 * requirements ask for, and one of the inputs an AI shopping assistant reads before it will
 * recommend an item ("does it ship to me, and for how much").
 *
 * Derived entirely from `SHIPPING_RATES` above, so it is zero-touch and can never disagree with
 * what checkout actually charges. The courier rate is published (not the cheaper pickup point):
 * a merchant listing states the cost of getting it to the buyer's address, and quoting the
 * cheaper method as the shipping cost would understate what most shoppers pay.
 *
 * **If the rate ever becomes zone-based, publish the HIGHEST one here.** Google documents a single
 * shipping figure for a product's structured data (per-region rates live in Merchant Center's own
 * account-level regions, which in Israel are defined by district, not postal code — checked against
 * their docs 2026-08-09, GO_LIVE §5.0.3). The asymmetry is what matters: publishing less than
 * checkout charges is a feed/landing-page mismatch, the one family that actually gets accounts
 * suspended; publishing more is merely unattractive.
 *
 * **`deliveryTime` is deliberately absent.** It is a recommended property, not a required one,
 * and the platform has no delivery-time commitment yet — that arrives with the real carrier
 * integration (GO_LIVE_CHECKLIST.md §5). An invented handling/transit window would be a promise
 * published in structured data, which is the one place a guess becomes a claim. Add it here, once,
 * when the carrier gives real numbers.
 */
export function offerShippingDetails(): Record<string, unknown> {
  return {
    '@type': 'OfferShippingDetails',
    shippingRate: {
      '@type': 'MonetaryAmount',
      value: String(SHIPPING_RATES.courier),
      currency: 'ILS',
    },
    shippingDestination: {
      '@type': 'DefinedRegion',
      addressCountry: 'IL',
    },
  };
}
