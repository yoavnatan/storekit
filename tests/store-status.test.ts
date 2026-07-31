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

describe('storeLifecycle — precedence', () => {
  it('is active when nothing is set', () => {
    expect(storeLifecycle({})).toBe('active');
  });

  it('reads each flag on its own', () => {
    expect(storeLifecycle({ pausedAt: T })).toBe('paused');
    expect(storeLifecycle({ closePendingAt: T })).toBe('closing');
    expect(storeLifecycle({ closedAt: T })).toBe('closed');
    expect(storeLifecycle({ blocked: true })).toBe('blocked');
  });

  // The one a seller could otherwise game: pause, then reopen, and walk out of an admin block.
  it('lets an admin block outrank every seller-set flag', () => {
    expect(storeLifecycle({ blocked: true, pausedAt: T, closePendingAt: T, closedAt: T })).toBe('blocked');
  });

  it('lets a completed closure outrank the pending one that preceded it', () => {
    expect(storeLifecycle({ pausedAt: T, closePendingAt: T, closedAt: T })).toBe('closed');
  });

  it('treats a pending closure as its own state, not as a plain pause', () => {
    expect(storeLifecycle({ pausedAt: T, closePendingAt: T })).toBe('closing');
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
    for (const store of [{ pausedAt: T }, { closePendingAt: T }]) {
      expect(isStoreReachable(store)).toBe(true);
      expect(isStoreDiscoverable(store)).toBe(false);
      expect(canStoreSell(store)).toBe(false);
      expect(storeHttpStatus(store)).toBe(200);
      expect(showsPausedNotice(store)).toBe(true);
    }
  });

  it('answers 410 for a closed store and 404 for a blocked one', () => {
    expect(storeHttpStatus({ closedAt: T })).toBe(410);
    expect(storeHttpStatus({ blocked: true })).toBe(404);
    expect(storeHttpStatus({})).toBe(200);
  });

  // A page that never renders has nothing to explain — the notice belongs to the states whose
  // storefront a shopper can still land on.
  it('never shows a shopper-facing notice for a state that serves no page', () => {
    expect(showsPausedNotice({ closedAt: T })).toBe(false);
    expect(showsPausedNotice({ blocked: true })).toBe(false);
    expect(showsPausedNotice({})).toBe(false);
  });

  it('has a rule row for every state the deriver can produce', () => {
    const produced: StoreLifecycle[] = [
      storeLifecycle({}),
      storeLifecycle({ pausedAt: T }),
      storeLifecycle({ closePendingAt: T }),
      storeLifecycle({ closedAt: T }),
      storeLifecycle({ blocked: true }),
    ];
    for (const state of produced) expect(STORE_LIFECYCLE_RULES[state]).toBeDefined();
    expect(new Set(produced).size).toBe(Object.keys(STORE_LIFECYCLE_RULES).length);
  });
});
