// own-store-guard — refuses an add-to-cart on a store the logged-in seller owns.
//
// Why at all: a seller browsing his own store is looking at the real storefront, so
// every buy control is live. Completing that purchase would be a real order — stock
// decremented, commission charged, buyer+seller mail sent, units counted toward the
// `popular`/`bestseller` performance label that feeds the Google/Meta product feed, and
// a commission he would be paying himself. None of that is what someone clicking around
// his own shop meant to do.
// (It used to say the sale would also START his monthly fee. That rule was withdrawn on
// 2026-08-24 — `lib/pricing.ts` — because selling is blocked until the subscription is
// running, so no sale can precede the first charge.)
//
// Why here and not per-button: the storefront adds to the cart from four places (server
// -rendered card, JS-rendered card, quick-view modal, product page + its mobile sticky
// bar). Guarding cart.ts#addItem covers all of them from one line, and a surface added
// later inherits it for free.
//
// What this deliberately leaves the seller without: any way to walk his own buying flow
// end to end. That gap is real, and it is filled by a dedicated "test order" — but only
// once there is a payment provider with a test mode to run it through, since before that
// it would just be a normal order with a flag. Registered as a row in
// GO_LIVE_CHECKLIST.md §3, together with the flag's required exclusions (revenue,
// purchasedUnits/ad labels, the first-sale billing trigger).
//
// Scope, deliberately: this is the *storefront* guard and it keys off the marker the
// owner's own store/product page renders. The seller's products also appear on the
// homepage, search and category pages, which do not know who owns what without a
// per-request lookup on every page a seller loads — so those still add to the cart, and
// /api/checkout's 403 is what actually stops the order. A hidden button is not a rule;
// the server check is (same split as the showcase-store guard in lib/demo-stores.ts).

import { showErrorToast } from './toast.js';

/** Marker the store/product page sets on its root element when the viewer owns the store. */
const OWNER_ATTR = 'data-owner-store';

/**
 * True when this page is the owner's own store AND `storeSlug` is that store — checked
 * per slug rather than page-wide, so a cross-store surface embedded here (a "from other
 * stores" cart row) is untouched.
 */
export function isOwnStore(storeSlug: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector<HTMLElement>(`[${OWNER_ATTR}]`);
  return !!el && el.getAttribute(OWNER_ATTR) === storeSlug;
}

/**
 * The chokepoint: returns true when the add must be refused, after telling the seller
 * why. A silent no-op would read as a broken button (see the no-op-interaction rule).
 */
export function blockOwnStorePurchase(storeSlug: string): boolean {
  if (!isOwnStore(storeSlug)) return false;
  const el = document.querySelector<HTMLElement>(`[${OWNER_ATTR}]`);
  showErrorToast(el?.dataset.ownerCannotBuy || 'לא ניתן לקנות מהחנות שלך');
  return true;
}
