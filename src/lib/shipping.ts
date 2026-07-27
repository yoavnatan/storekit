// Delivery/shipping model — platform-provided. Prices are PLATFORM-set (SHIPPING_RATES
// below), never per-seller: a store receives shipping as a service through us and does
// not profit from it. The seller's only lever is whether to also offer self-pickup from
// the store address. Pure/isomorphic (no node:fs) so the checkout server route and the
// browser-bundled checkout script import the same single source of truth — mirror of how
// variant-combo.ts is shared across both sides.

export type DeliveryMethod = 'pickup' | 'courier' | 'pickup_point';

/** Platform shipping rates in ILS — central, identical for every store. Change here to
 *  change it everywhere. Self-pickup is always free and never appears here. (Real carrier
 *  billing arrives with the Sendit integration — GO_LIVE §5.) */
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
