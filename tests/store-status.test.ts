import { describe, it, expect } from 'vitest';
import {
  STORE_LIFECYCLE_RULES,
  storeLifecycle,
  isStoreReachable,
  isStoreDiscoverable,
  canStoreSell,
  storeHttpStatus,
  showsPausedNotice,
  type StoreLifecycle,
} from '../src/lib/store-status.js';

const T = '2026-07-31T10:00:00.000Z';
/** A store that went public. Every case below that is about one of the OTHER states carries it, so
 *  the state under test is the only reason the answer comes out the way it does — without it every
 *  fixture here is `unpublished`, and a suite about precedence would be asserting one flag. */
const LIVE = { publishedAt: T };

describe('storeLifecycle — precedence', () => {
  it('is active once it has been published and nothing else is set', () => {
    expect(storeLifecycle(LIVE)).toBe('active');
  });

  // The state that separates "a seller is still building" from "a shopper can reach it". It is a
  // fact about the store record and not about the seller's account, so it is derived from the
  // absence of the timestamp and from nothing else.
  it('is unpublished until it has been published', () => {
    expect(storeLifecycle({})).toBe('unpublished');
  });

  // Below `paused`: an unpublished store cannot meaningfully be paused, and if both are somehow
  // true the two answer identically on every row that matters — so the deliberate seller action is
  // the one worth naming.
  it('lets a seller-set halt outrank the unpublished state', () => {
    expect(storeLifecycle({ pausedAt: T })).toBe('paused');
    expect(storeLifecycle({ blocked: true })).toBe('blocked');
  });

  it('reads each flag on its own', () => {
    expect(storeLifecycle({ ...LIVE, pausedAt: T })).toBe('paused');
    expect(storeLifecycle({ ...LIVE, closePendingAt: T })).toBe('closing');
    expect(storeLifecycle({ ...LIVE, closedAt: T })).toBe('closed');
    expect(storeLifecycle({ ...LIVE, blocked: true })).toBe('blocked');
  });

  // The one a seller could otherwise game: pause, then reopen, and walk out of an admin block.
  it('lets an admin block outrank every seller-set flag', () => {
    expect(storeLifecycle({ ...LIVE, blocked: true, pausedAt: T, closePendingAt: T, closedAt: T })).toBe('blocked');
  });

  it('lets a completed closure outrank the pending one that preceded it', () => {
    expect(storeLifecycle({ ...LIVE, pausedAt: T, closePendingAt: T, closedAt: T })).toBe('closed');
  });

  it('treats a pending closure as its own state, not as a plain pause', () => {
    expect(storeLifecycle({ ...LIVE, pausedAt: T, closePendingAt: T })).toBe('closing');
  });
});

describe('what each state permits', () => {
  it('only an active store may be listed or sold from', () => {
    const sellable = (Object.keys(STORE_LIFECYCLE_RULES) as StoreLifecycle[])
      .filter((s) => STORE_LIFECYCLE_RULES[s].sellable);
    expect(sellable).toEqual(['active']);
    const discoverable = (Object.keys(STORE_LIFECYCLE_RULES) as StoreLifecycle[])
      .filter((s) => STORE_LIFECYCLE_RULES[s].discoverable);
    expect(discoverable).toEqual(['active']);
  });

  // The whole point of pausing rather than 404-ing: the URL keeps working, so the store's
  // accumulated Google standing survives an operational halt.
  it('keeps a paused or closing store reachable but unbuyable and unlisted', () => {
    for (const store of [{ ...LIVE, pausedAt: T }, { ...LIVE, closePendingAt: T }]) {
      expect(isStoreReachable(store)).toBe(true);
      expect(isStoreDiscoverable(store)).toBe(false);
      expect(canStoreSell(store)).toBe(false);
      expect(storeHttpStatus(store)).toBe(200);
      expect(showsPausedNotice(store)).toBe(true);
    }
  });

  it('answers 410 for a closed store and 404 for a blocked one', () => {
    expect(storeHttpStatus({ ...LIVE, closedAt: T })).toBe(410);
    expect(storeHttpStatus({ ...LIVE, blocked: true })).toBe(404);
    expect(storeHttpStatus(LIVE)).toBe(200);
    // 404 and not 410: it is not gone, it has not arrived. The seller may publish it tomorrow, and
    // 410 would tell Google to forget a URL that is about to be real.
    expect(storeHttpStatus({})).toBe(404);
  });

  // A page that never renders has nothing to explain — the notice belongs to the states whose
  // storefront a shopper can still land on.
  it('never shows a shopper-facing notice for a state that serves no page', () => {
    expect(showsPausedNotice({ ...LIVE, closedAt: T })).toBe(false);
    expect(showsPausedNotice({ ...LIVE, blocked: true })).toBe(false);
    expect(showsPausedNotice(LIVE)).toBe(false);
    // An unpublished store serves no page to a shopper either — its owner sees the ordinary
    // storefront, and a "closed" notice on it would be a lie to the one person who can read it.
    expect(showsPausedNotice({})).toBe(false);
  });

  it('has a rule row for every state the deriver can produce', () => {
    const produced: StoreLifecycle[] = [
      storeLifecycle(LIVE),
      storeLifecycle({}),
      storeLifecycle({ ...LIVE, pausedAt: T }),
      storeLifecycle({ ...LIVE, closePendingAt: T }),
      storeLifecycle({ ...LIVE, closedAt: T }),
      storeLifecycle({ ...LIVE, blocked: true }),
    ];
    for (const state of produced) expect(STORE_LIFECYCLE_RULES[state]).toBeDefined();
    expect(new Set(produced).size).toBe(Object.keys(STORE_LIFECYCLE_RULES).length);
  });
});
