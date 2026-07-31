/** What state a store is in, as one table — the same shape (and for the same reason) as
 *  order-status-rules.ts.
 *
 *  Four different things can take a store off the shelf, and they are NOT the same event:
 *
 *    active   the normal state.
 *    paused   the SELLER stopped selling — an operational halt (restocking, a move, a break in
 *             activity). Not a holiday mode and not a soft-delete: the storefront stays up and
 *             says so, and nothing about the store is lost. Reversible in one click.
 *    closing  the seller asked to close while orders were still open. The store stops selling
 *             immediately (identical to `paused` for every shopper-facing purpose) and the
 *             closure completes BY ITSELF once the last open order is done — store-lifecycle.ts
 *             #settleStoreClosure. A seller who has to remember to come back and press the
 *             button again is a manual step in a zero-touch platform.
 *    closed   final. The store leaves the site.
 *    blocked  the ADMIN took it down (admin-moderation.ts) — a penalty, not a seller decision,
 *             and the only one of the five a seller cannot undo.
 *
 *  Precedence is the order above, reversed: an admin block outranks whatever the seller chose,
 *  so a blocked store cannot be un-blocked by pausing and un-pausing it.
 *
 *  NOTHING here deletes anything. Every state is a flag on the store record, so orders, money
 *  events, ad spend and every historical figure derived from them stay exactly as they were —
 *  a closed store's past is still part of the platform's totals, because it happened.
 *
 *  Pure: takes the flags, never reads a file, so a page, an API route and a test all answer
 *  identically.
 */

export type StoreLifecycle = 'active' | 'paused' | 'closing' | 'closed' | 'blocked';

export interface StoreLifecycleRule {
  /** Does the store's own URL serve the storefront? A paused store deliberately still does —
   *  going 404 for a two-week operational halt throws away the Google standing the store built,
   *  and that standing is the platform's whole pitch. It comes back the moment it reopens. */
  reachable: boolean;
  /** May a platform surface LIST it — homepage, /stores, search, sitemap, llms.txt, the
   *  Merchant/Meta product feed? Also drives `noindex` on the storefront: a page that no
   *  discovery surface links to must not be indexed either. */
  discoverable: boolean;
  /** May anything be bought? Gates add-to-cart, the cart price refresh and checkout itself.
   *  Separate from `discoverable` on purpose: they agree in every row today, but they answer
   *  different questions and a future state (a store listed but not yet accepting orders) would
   *  split them. */
  sellable: boolean;
  /** When unreachable, is it permanent? Decides 410 Gone vs 404: a closed store is gone for
   *  good and 410 gets it out of the index quickly and cleanly, while a blocked store may well
   *  come back and 404 leaves that door open. */
  gone: boolean;
}

export const STORE_LIFECYCLE_RULES: Record<StoreLifecycle, StoreLifecycleRule> = {
  active:  { reachable: true,  discoverable: true,  sellable: true,  gone: false },
  paused:  { reachable: true,  discoverable: false, sellable: false, gone: false },
  closing: { reachable: true,  discoverable: false, sellable: false, gone: false },
  closed:  { reachable: false, discoverable: false, sellable: false, gone: true  },
  blocked: { reachable: false, discoverable: false, sellable: false, gone: false },
};

/** The store fields this module reads. Declared as its own interface so the pure logic can be
 *  tested (and reused) without constructing a whole Store. */
export interface StoreLifecycleFlags {
  blocked?: boolean;
  /** Seller stopped selling at this instant. Cleared on reopen. */
  pausedAt?: string;
  /** Seller asked to close at this instant, while orders were still open. Implies paused. */
  closePendingAt?: string;
  /** Closure completed at this instant. Terminal. */
  closedAt?: string;
}

export function storeLifecycle(store: StoreLifecycleFlags): StoreLifecycle {
  if (store.blocked) return 'blocked';
  if (store.closedAt) return 'closed';
  if (store.closePendingAt) return 'closing';
  if (store.pausedAt) return 'paused';
  return 'active';
}

export function isStoreReachable(store: StoreLifecycleFlags): boolean {
  return STORE_LIFECYCLE_RULES[storeLifecycle(store)].reachable;
}

export function isStoreDiscoverable(store: StoreLifecycleFlags): boolean {
  return STORE_LIFECYCLE_RULES[storeLifecycle(store)].discoverable;
}

export function canStoreSell(store: StoreLifecycleFlags): boolean {
  return STORE_LIFECYCLE_RULES[storeLifecycle(store)].sellable;
}

/** The HTTP status an unreachable store's URL answers with. 200 while reachable. */
export function storeHttpStatus(store: StoreLifecycleFlags): 200 | 404 | 410 {
  const rule = STORE_LIFECYCLE_RULES[storeLifecycle(store)];
  if (rule.reachable) return 200;
  return rule.gone ? 410 : 404;
}

/** Is the seller's own halt in force — the one case where the storefront stays up and has to
 *  EXPLAIN itself to a shopper who followed a link in. An admin block and a completed closure
 *  never render a page at all, so neither of them says anything. */
export function showsPausedNotice(store: StoreLifecycleFlags): boolean {
  const state = storeLifecycle(store);
  return state === 'paused' || state === 'closing';
}
