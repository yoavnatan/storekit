/**
 * Showcase ("חנות לדוגמה") stores — platform-owned stores that exist so the mall
 * isn't a hypothetical on day one. See GO_LIVE_CHECKLIST.md §6.2 for the agreed
 * spec; this module is the single place the rules are expressed.
 *
 * Why they exist: the first seller has to see a FINISHED store to understand what
 * he's signing up for, and the homepage spotlight is a dead static block below two
 * stores (its arrows + auto-rotation are gated on `feed.spotlight.length > 1`).
 * Hence three, each a different kind of store, not one.
 *
 * The three rules that matter, and why they are NOT the same rule:
 *   1. A demo store is never *indexable* — no sitemap, no product feed, no
 *      IndexNow, `noindex` on its pages. Fabricated catalog in Google's index (or
 *      in Merchant Center, where it's a policy problem and not just an aesthetic
 *      one) costs the platform domain far more than the stores are worth.
 *   2. A demo store is never *counted* — `isLaunchMode` and every "do we have
 *      enough stores yet" threshold must see real stores only, otherwise the
 *      demo stores suppress the very launch mode they were meant to fill.
 *   3. A demo store is *shown to shoppers only while the mall is thin*. Past the
 *      real-store threshold they drop out of discovery on their own. Their pages
 *      stay reachable by direct link forever — that's the seller-facing
 *      "ראה חנות לדוגמה" entry point, which never expires.
 *
 * Buying is deliberately half-open: the cart works end to end (a prospective
 * seller should see the real flow), and only the final checkout is refused —
 * server-side, in /api/checkout, not by hiding a button. On the checkout page
 * that refusal is per-ITEM, never per-cart (see splitDemoCarts): a demo item
 * next to a real one used to disable the pay button outright, which punished the
 * buyer for a decision the platform made.
 *
 * Pure module — no fs, no Astro. Covered by tests/demo-stores.test.ts.
 */

import { LAUNCH_MODE_MAX_STORES } from './launch-mode.js';

/** The minimum a store must carry to be treated as a demo store by this module. */
export interface DemoFlagged {
  demo?: boolean;
}

/** At this many REAL stores the showcase stores leave the shopper-facing surfaces.
 *  Tied to the launch-mode threshold on purpose: the demo stores exist to cover
 *  exactly the window launch mode covers, and two independent numbers would drift
 *  into a gap (mall out of launch mode, demo stores still on the homepage). */
export const DEMO_HIDE_AT_REAL_STORES = LAUNCH_MODE_MAX_STORES;

export function isDemoStore(store: DemoFlagged): boolean {
  return store.demo === true;
}

/** Stores that count toward every threshold — i.e. everything except the ones the
 *  platform stocked itself. */
/**
 * How many visible products a real store needs before it counts toward "the mall has enough real
 * stores" (owner, 2026-08-18, asked what the bar should be and set it here).
 *
 * **It was one, and one is too few.** The bar started as `hasProducts` — the flag a store CARD
 * uses, which is the right question for drawing a card and the wrong one for this. Five stores with
 * a single product each would switch the mall out of launch mode and take the stocked showcase
 * stores off the homepage with them, leaving a discovery page that is technically full and visibly
 * empty. Five products is roughly where a shelf stops reading as a placeholder.
 *
 * Deliberately NOT the same number as the store threshold it feeds; they are different quantities
 * that happen to coincide today, and tying them would make one move whenever the other did.
 */
export const LIVE_STORE_MIN_PRODUCTS = 5;

/** Does this store have enough to sell to count as a live one? The single definition — a surface
 *  comparing `productCount` against its own literal is how two pages start disagreeing about what
 *  a real store is. */
export function isLiveStore(preview: { productCount?: number } | undefined): boolean {
  return (preview?.productCount ?? 0) >= LIVE_STORE_MIN_PRODUCTS;
}

export function realStores<T extends DemoFlagged>(stores: readonly T[]): T[] {
  return stores.filter((s) => !isDemoStore(s));
}

export function countRealStores(stores: readonly DemoFlagged[]): number {
  return realStores(stores).length;
}

export function showDemoStores(realStoreCount: number): boolean {
  return realStoreCount < DEMO_HIDE_AT_REAL_STORES;
}

/**
 * What a shopper-facing discovery surface (homepage, /stores, search) should list:
 * every store while the mall is thin, real stores only once it isn't.
 *
 * Takes the whole set and decides from it rather than from a caller-supplied count,
 * so a call site can't pass a count that already includes the demo stores — the
 * self-suppression bug this whole module exists to avoid.
 */
/**
 * @param liveRealCount How many REAL stores actually have something to sell. Optional only so a
 *   caller with no product data still gets the old behaviour rather than a crash — pass it wherever
 *   it can be known, which is every discovery surface.
 *
 * **Why the count is a parameter rather than `real.length` (owner, 2026-08-18).** The two
 * thresholds on the homepage were counting different things: launch mode already asked how many
 * real stores have PRODUCTS, while this function asked how many exist at all. Five empty real
 * stores therefore hid the showcase stores — which exist precisely to fill a thin mall — while
 * leaving launch mode on, producing the one state nobody wants: the stocked stores gone and five
 * empty ones in their place. It was visible the moment seven product-less stores appeared in the
 * dev database and the homepage emptied out.
 *
 * The rule now matches the one it was always tied to: a store with nothing to sell does not count
 * toward "the mall has enough real stores", because a shopper cannot buy from it.
 */
export function filterShopperStores<T extends DemoFlagged>(stores: readonly T[], liveRealCount?: number): T[] {
  const real = realStores(stores);
  return showDemoStores(liveRealCount ?? real.length) ? [...stores] : real;
}

/** Anything the checkout groups by store — the per-store carts it renders. */
export interface StoreScoped {
  storeSlug: string;
}

export interface CartSplit<T> {
  /** Carts the buyer may actually select, pay for and be charged for. */
  payable: T[];
  /** Carts that stay in the cart, visibly, but never enter an order. */
  viewOnly: T[];
}

/**
 * Splits the checkout's per-store carts into payable and view-only.
 *
 * This is the whole "a demo item must not block a real one" rule, in one place:
 * the refusal is scoped to the demo store's own items, so a cart holding one
 * showcase product and one real product still checks out — it just checks out
 * without the showcase product. Blocking the entire order (what the page did
 * until 2026-07-29) made the platform's own filler cost the buyer their real
 * purchase, which is the opposite of what the showcase stores are for.
 *
 * `payable` empty is the one case that still refuses outright — a cart with
 * nothing but showcase items has nothing to charge for.
 *
 * Pure — covered by tests/demo-stores.test.ts. /api/checkout's own 403 stays the
 * authority: this decides what the page SENDS, not what the server accepts.
 */
export function splitDemoCarts<T extends StoreScoped>(
  carts: readonly T[],
  isDemoSlug: (storeSlug: string) => boolean,
): CartSplit<T> {
  const payable: T[] = [];
  const viewOnly: T[] = [];
  for (const cart of carts) (isDemoSlug(cart.storeSlug) ? viewOnly : payable).push(cart);
  return { payable, viewOnly };
}
