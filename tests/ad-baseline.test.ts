import { describe, expect, it } from 'vitest';
import { storeBaselineStatus } from '../src/lib/ad-baseline.js';

/** Admin-only since 2026-08-25 — the seller's Advertising tab no longer shows this at all (why:
 *  `tests/baseline-claim-silent.test.ts`). The function stays, and so do these, because the
 *  admin's per-store card still reports what the platform campaign accrued for a store, and the
 *  two ways the figure used to be false are still ways it could be false: a number with no window
 *  behind it, and "active" on a store the feed does not carry. */
const TODAY = new Date('2026-07-30T00:00:00Z');

describe('storeBaselineStatus', () => {
  it('carries a store that has something to promote', () => {
    const s = storeBaselineStatus({ storeId: 's1', discoverable: true, visibleProductCount: 3 }, TODAY);
    expect(s.active).toBe(true);
    expect(s.impressions).toBeGreaterThan(0);
  });

  it('does not claim to advertise a store with no visible product, and says which reason it is', () => {
    expect(storeBaselineStatus({ storeId: 's1', discoverable: true, visibleProductCount: 0 }, TODAY))
      .toEqual({ active: false, reason: 'no-products', impressions: 0 });
  });

  /**
   * **The reason is a value because one sentence was wrong for the commonest case.** The card told
   * every inactive store to add a visible product — including a shop that simply was not on the
   * site yet, whose seller then went looking for a product he already had (owner, 2026-08-25).
   * `discoverable: false` covers unpublished as well as paused/closed/blocked, and it outranks the
   * product count: a shop that is not up cannot be advertised however full it is.
   */
  it('does not claim to advertise a store no platform surface carries, and blames the right thing', () => {
    expect(storeBaselineStatus({ storeId: 's1', discoverable: false, visibleProductCount: 9 }, TODAY))
      .toEqual({ active: false, reason: 'not-live', impressions: 0 });
    // Both wrong at once: the one he can act on FIRST is the one he is told.
    expect(storeBaselineStatus({ storeId: 's1', discoverable: false, visibleProductCount: 0 }, TODAY).reason)
      .toBe('not-live');
  });

  // The label says "last 30 days". Before this the figure was a flat seeded number that never
  // moved, so the label was decoration — a period no arithmetic stood behind.
  it('reports a real 30-day window, and is stable for the same store and day', () => {
    const a = storeBaselineStatus({ storeId: 's1', discoverable: true, visibleProductCount: 1 }, TODAY);
    const b = storeBaselineStatus({ storeId: 's1', discoverable: true, visibleProductCount: 1 }, TODAY);
    const other = storeBaselineStatus({ storeId: 's2', discoverable: true, visibleProductCount: 1 }, TODAY);
    expect(a.impressions).toBe(b.impressions);
    expect(a.impressions).not.toBe(other.impressions);
    // ~15–90 impressions a day over 30 days (ad-metrics.ts#baselineImpressionsInRange).
    expect(a.impressions).toBeGreaterThanOrEqual(15 * 30);
    expect(a.impressions).toBeLessThanOrEqual(90 * 30);
  });
});
