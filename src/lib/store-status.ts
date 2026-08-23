/** What state a store is in, as one table — the same shape (and for the same reason) as
 *  order-status-rules.ts.
 *
 *  Five different things can keep a store off the shelf, and they are NOT the same event:
 *
 *    active       the normal state.
 *    unpublished  built, never public. The seller registers, fills the shop and looks at it before
 *             he is ever asked for a card (owner, 2026-08-23) — so "the store row exists" and
 *             "strangers can reach it" are now separated by a real interval. TWO independent
 *             things hold a store inside it, and they are deliberately ONE state: PayMe examine
 *             every business before it may clear a card (up to seven business days, agreement
 *             §11), and a seller who has not started a subscription is not paying to be on the
 *             platform. The consequence is identical either way — the seller sees his shop, the
 *             public does not — so what differs is only the sentence he is told, which is
 *             `lib/store-publication.ts`'s job. Two flags would have been able to contradict each
 *             other; one state cannot. It ends by itself, with nothing to press:
 *             `syncStorePublication` runs when either hold lifts.
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
 *  so a blocked store cannot be un-blocked by pausing and un-pausing it. `unpublished` sits at the
 *  BOTTOM of that order, below `paused`: a store that never went live cannot meaningfully be
 *  paused, and if both are somehow true the two answer identically on every row that matters — so
 *  the deliberate seller action is the one worth naming.
 *
 *  NOTHING here deletes anything. Every state is a flag on the store record, so orders, money
 *  events, ad spend and every historical figure derived from them stay exactly as they were —
 *  a closed store's past is still part of the platform's totals, because it happened.
 *
 *  Pure: takes the flags, never reads a file, so a page, an API route and a test all answer
 *  identically.
 */

export type StoreLifecycle = 'active' | 'unpublished' | 'paused' | 'closing' | 'closed' | 'blocked';

export interface StoreLifecycleRule {
  /** Does the store's own URL serve the storefront **to the public**? A paused store deliberately
   *  still does —
   *  going 404 for a two-week operational halt throws away the Google standing the store built,
   *  and that standing is the platform's whole pitch. It comes back the moment it reopens.
   *
   *  An `unpublished` store answers false and therefore 404s — it has no standing to lose, has
   *  never been linked from anywhere, and a shop a stranger can read but not buy from is the exact
   *  thing this state exists to prevent. **Its OWNER still sees it**, which is not an exception to
   *  this flag: the owner check is a separate question the storefront route asks after this one
   *  (`store-publication.ts#mayPreviewStore`), so nothing here has to know about sessions. */
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
  active:      { reachable: true,  discoverable: true,  sellable: true,  gone: false },
  unpublished: { reachable: false, discoverable: false, sellable: false, gone: false },
  paused:      { reachable: true,  discoverable: false, sellable: false, gone: false },
  closing:     { reachable: true,  discoverable: false, sellable: false, gone: false },
  closed:      { reachable: false, discoverable: false, sellable: false, gone: true  },
  blocked:     { reachable: false, discoverable: false, sellable: false, gone: false },
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
  /** When the store first became public. Absent = never was — see `unpublished` above. Written
   *  only by lib/store-publication.ts and never cleared: taking a live store off the site is what
   *  pause, close and block are for, and each of those carries its own reason. */
  publishedAt?: string;
}

export function storeLifecycle(store: StoreLifecycleFlags): StoreLifecycle {
  if (store.blocked) return 'blocked';
  if (store.closedAt) return 'closed';
  if (store.closePendingAt) return 'closing';
  if (store.pausedAt) return 'paused';
  if (!store.publishedAt) return 'unpublished';
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

/** Is the store live to the public — the one question most callers actually mean by "is it on the
 *  site". True only for `active`: every other state either 404s, says it is closed, or was never
 *  published. */
export function isStorePublished(store: StoreLifecycleFlags): boolean {
  return storeLifecycle(store) === 'active';
}
