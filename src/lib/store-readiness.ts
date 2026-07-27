/** Store readiness — the hard line between "a seller is still setting up" and "a shopper can
 *  actually buy here".
 *
 *  Everything in lib/seller-onboarding.ts is *guidance*; this file is the *gate*. A store that
 *  fails it must never reach a shopper through a platform surface — not the sitemap, not search,
 *  not a discovery shelf — because every one of those is a promise that the link leads somewhere
 *  you can buy from. Sending a shopper (or Googlebot) to an empty storefront costs the platform's
 *  own domain trust, which is exactly what the shared-domain SEO bet cannot afford.
 *
 *  Deliberately NOT a 404: an unready store's direct URL keeps working so the seller can preview
 *  it and send it to friends. It is simply undiscoverable and `noindex` until it's real.
 *
 *  Pure/isomorphic — takes counts and flags, never reads files.
 *
 *  Why "no visible product" is the only blocker today:
 *   • self-pickup-without-address is already impossible upstream — /api/store rejects enabling the
 *     toggle without an address, and both checkout paths re-check `store.address` before offering
 *     the method. Re-blocking it here would be a second source of truth for a solved problem.
 *   • name + URL are required at store creation, so they can't be missing.
 *   • business/legal identity (ח.פ. / עוסק מורשה, terms acceptance) SHOULD become a blocker — those
 *     fields don't exist on the Seller record yet. This is the extension point: add the blocker
 *     here and every surface below inherits it.
 */

export type StoreBlocker = 'noProducts';

export interface StoreReadinessInput {
  /** Products that a shopper can actually see — already gated for hidden/blocked. */
  visibleProductCount: number;
}

export interface StoreReadiness {
  ready: boolean;
  /** Empty when ready. Ordered, so a UI can show "the next thing to fix" first. */
  blockers: StoreBlocker[];
}

export function buildStoreReadiness(input: StoreReadinessInput): StoreReadiness {
  const blockers: StoreBlocker[] = [];
  if (input.visibleProductCount <= 0) blockers.push('noProducts');
  return { ready: blockers.length === 0, blockers };
}

/** Convenience for the discovery/sitemap/search call sites, which only care about the verdict. */
export function isStoreReady(input: StoreReadinessInput): boolean {
  return buildStoreReadiness(input).ready;
}
