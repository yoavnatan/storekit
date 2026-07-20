import { describe, it, expect } from 'vitest';
import { baselineImpressionsInRange, campaignStatsInRange, campaignLifetimeStats, campaignRunPeriod, brandStatsInRange } from '../src/lib/ad-metrics.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';
import type { BrandCampaign } from '../src/lib/brand-campaigns.js';

function campaign(over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: 'c1', storeId: 's1', storeSlug: 's1', scope: 'store', platform: 'google',
    monthlyBudget: 300, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
function brand(over: Partial<BrandCampaign> = {}): BrandCampaign {
  return {
    id: 'b1', objective: 'buyers', headline: 'x', body: 'y', destinationUrl: '/', platform: 'google',
    monthlyBudget: 600, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('ad-metrics (range-aware mock)', () => {
  it('baseline is deterministic and scales with range length', () => {
    const a = baselineImpressionsInRange('s1', '2026-07-14', '2026-07-20'); // 7 days
    const b = baselineImpressionsInRange('s1', '2026-07-14', '2026-07-20');
    const long = baselineImpressionsInRange('s1', '2026-06-21', '2026-07-20'); // 30 days
    expect(a).toBe(b);                 // deterministic
    expect(long).toBeGreaterThan(a);   // more days → more impressions
  });

  it('campaign: created after range → zero, active → positive, deterministic', () => {
    // Campaign created 2026-08 but range is in July → not yet live → zero.
    expect(campaignStatsInRange(campaign({ createdAt: '2026-08-01T00:00:00.000Z' }), '2026-07-14', '2026-07-20').impressions).toBe(0);
    const live = campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20');
    expect(live.impressions).toBeGreaterThan(0);
    expect(live.spend).toBeGreaterThan(0);
    expect(campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20')).toEqual(live); // deterministic
  });

  it('campaign spend counts only the days it was live within the range', () => {
    // Created mid-range (2026-07-18) → only 3 of the 7 range-days count.
    const partial = campaignStatsInRange(campaign({ createdAt: '2026-07-18T00:00:00.000Z' }), '2026-07-14', '2026-07-20');
    const full = campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20');
    expect(partial.spend).toBeLessThan(full.spend);
    expect(partial.spend).toBeGreaterThan(0);
  });

  it('pausing FREEZES accrued metrics, it does NOT erase them (item 1)', () => {
    // Active 2026-07-01 → paused 2026-07-10.
    const paused = campaign({ status: 'paused', createdAt: '2026-07-01T00:00:00.000Z', pausedAt: '2026-07-10T00:00:00.000Z' });
    // A window INSIDE the active period still reports the days it ran — not zero.
    expect(campaignStatsInRange(paused, '2026-07-05', '2026-07-08').impressions).toBeGreaterThan(0);
    // A window entirely AFTER the pause reports zero (it wasn't running then).
    expect(campaignStatsInRange(paused, '2026-07-12', '2026-07-15').impressions).toBe(0);
    // Lifetime = exactly the active window 07-01→07-10, frozen at the pause.
    const lifetime = campaignLifetimeStats(paused, new Date(2026, 6, 20));
    const activeEquivalent = campaignStatsInRange(campaign({ createdAt: '2026-07-01T00:00:00.000Z' }), '2026-07-01', '2026-07-10');
    expect(lifetime).toEqual(activeEquivalent);
    expect(campaignRunPeriod(paused, new Date(2026, 6, 20))).toMatchObject({ start: '2026-07-01', end: '2026-07-10', days: 10 });
  });

  it('lifetime respects a fixed duration cap', () => {
    const c = campaign({ createdAt: '2026-07-01T00:00:00.000Z', durationDays: 7 });
    // Runs 07-01..07-07 (7 days) regardless of how long ago that was.
    expect(campaignRunPeriod(c, new Date(2026, 6, 20))).toMatchObject({ start: '2026-07-01', end: '2026-07-07', days: 7 });
    const capped = campaignLifetimeStats(c, new Date(2026, 6, 20));
    const sevenDays = campaignStatsInRange(campaign({ createdAt: '2026-07-01T00:00:00.000Z' }), '2026-07-01', '2026-07-07');
    expect(capped).toEqual(sevenDays);
  });

  it('brand: conversions never exceed clicks; paused → zero', () => {
    const s = brandStatsInRange(brand(), '2026-07-14', '2026-07-20');
    expect(s.conversions).toBeLessThanOrEqual(s.clicks);
    expect(brandStatsInRange(brand({ status: 'paused' }), '2026-07-14', '2026-07-20').impressions).toBe(0);
  });
});
