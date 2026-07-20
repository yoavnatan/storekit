import { describe, it, expect } from 'vitest';
import { baselineImpressionsInRange, campaignStatsInRange, brandStatsInRange } from '../src/lib/ad-metrics.js';
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

  it('campaign: paused → zero, created after range → zero, active → positive', () => {
    expect(campaignStatsInRange(campaign({ status: 'paused' }), '2026-07-14', '2026-07-20')).toMatchObject({ impressions: 0, spend: 0 });
    // Campaign created 2026-08 but range is in July → not yet live → zero.
    expect(campaignStatsInRange(campaign({ createdAt: '2026-08-01T00:00:00.000Z' }), '2026-07-14', '2026-07-20').impressions).toBe(0);
    const live = campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20');
    expect(live.impressions).toBeGreaterThan(0);
    expect(live.spend).toBeGreaterThan(0);
    // Deterministic.
    expect(campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20')).toEqual(live);
  });

  it('campaign spend counts only the days it was live within the range', () => {
    // Created mid-range (2026-07-18) → only 3 of the 7 range-days count.
    const partial = campaignStatsInRange(campaign({ createdAt: '2026-07-18T00:00:00.000Z' }), '2026-07-14', '2026-07-20');
    const full = campaignStatsInRange(campaign(), '2026-07-14', '2026-07-20');
    expect(partial.spend).toBeLessThan(full.spend);
    expect(partial.spend).toBeGreaterThan(0);
  });

  it('brand: conversions never exceed clicks; paused → zero', () => {
    const s = brandStatsInRange(brand(), '2026-07-14', '2026-07-20');
    expect(s.conversions).toBeLessThanOrEqual(s.clicks);
    expect(brandStatsInRange(brand({ status: 'paused' }), '2026-07-14', '2026-07-20').impressions).toBe(0);
  });
});
