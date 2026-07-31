import { describe, expect, it } from 'vitest';
import { storeBaselineStatus } from '../src/lib/ad-baseline.js';

/** The baseline card is the first thing a seller reads on the Advertising tab, and it is the one
 *  place the platform makes a claim about what IT is doing for him. These pin the two ways that
 *  claim used to be false: a number with no window behind it, and "active" on a store the feed
 *  does not carry. */
const TODAY = new Date('2026-07-30T00:00:00Z');

describe('storeBaselineStatus', () => {
  it('carries a store that has something to promote', () => {
    const s = storeBaselineStatus({ storeId: 's1', discoverable: true, visibleProductCount: 3 }, TODAY);
    expect(s.active).toBe(true);
    expect(s.impressions).toBeGreaterThan(0);
  });

  it('does not claim to advertise a store with no visible product', () => {
    expect(storeBaselineStatus({ storeId: 's1', discoverable: true, visibleProductCount: 0 }, TODAY))
      .toEqual({ active: false, impressions: 0 });
  });

  it('does not claim to advertise a store no platform surface carries (blocked, paused or closed)', () => {
    expect(storeBaselineStatus({ storeId: 's1', discoverable: false, visibleProductCount: 9 }, TODAY))
      .toEqual({ active: false, impressions: 0 });
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
