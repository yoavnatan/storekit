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
export function filterShopperStores<T extends DemoFlagged>(stores: readonly T[]): T[] {
  const real = realStores(stores);
  return showDemoStores(real.length) ? [...stores] : real;
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
