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
 * server-side, in /api/checkout, not by hiding a button.
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
