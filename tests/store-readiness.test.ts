import { describe, expect, it } from 'vitest';
import { buildStoreReadiness, isStoreReady } from '../src/lib/store-readiness.js';

describe('store readiness — the discovery gate', () => {
  it('blocks a store with no visible product', () => {
    expect(buildStoreReadiness({ visibleProductCount: 0 })).toEqual({ ready: false, blockers: ['noProducts'] });
    expect(isStoreReady({ visibleProductCount: 0 })).toBe(false);
  });

  it('clears as soon as one visible product exists', () => {
    expect(buildStoreReadiness({ visibleProductCount: 1 })).toEqual({ ready: true, blockers: [] });
    expect(isStoreReady({ visibleProductCount: 1 })).toBe(true);
  });

  it('treats a negative count as not ready rather than throwing', () => {
    expect(isStoreReady({ visibleProductCount: -1 })).toBe(false);
  });
});
