// Delivery/shipping model — platform-provided. Prices are PLATFORM-set (SHIPPING_RATES
// below), never per-seller: a store receives shipping as a service through us and does
// not profit from it. The seller's only lever is whether to also offer self-pickup from
// the store address. Pure/isomorphic (no node:fs) so the checkout server route and the
// browser-bundled checkout script import the same single source of truth — mirror of how
// variant-combo.ts is shared across both sides.

export type DeliveryMethod = 'pickup' | 'courier' | 'pickup_point';

/** Platform shipping rates in ILS — central, identical for every store. Change here to
 *  change it everywhere. Self-pickup is always free and never appears here. (Real carrier
 *  billing arrives with the courier integration — GO_LIVE §5.) */
export const SHIPPING_RATES = {
  courier: 30,
  pickup_point: 20,
} as const;

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
