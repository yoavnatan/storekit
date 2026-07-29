import { describe, it, expect } from 'vitest';
import { buildPlatformRevenue } from '../src/lib/platform-revenue.js';
import { AD_PLATFORM_MARGIN_PERCENT, monthlyFeeForTier } from '../src/lib/pricing.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';

const FROM = '2026-07-01';
const TO = '2026-07-30'; // exactly 30 days → one whole billing month

function seller(tier: string | undefined, createdAt: string) {
  return { tier, createdAt };
}

function campaign(id: string, monthlyBudget: number, createdAt: string, over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id,
    storeId: 'st1',
    storeSlug: 'store',
    scope: 'store',
    platform: 'google',
    monthlyBudget,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

describe('buildPlatformRevenue — the three income streams', () => {
  it('adds commission + subscriptions + ad margin, and nothing else', () => {
    const r = buildPlatformRevenue(1000, 11, [seller('starter', '2026-01-01T00:00:00.000Z')], [], FROM, TO);
    expect(r.commission).toBe(1000);
    expect(r.subscriptions).toBe(monthlyFeeForTier('starter')); // full 30-day month
    expect(r.adMargin).toBe(0);
    expect(r.total).toBe(1000 + monthlyFeeForTier('starter'));
    expect(r.subscribers).toBe(1);
  });

  it('bills each seller at their OWN tier fee, not one platform number', () => {
    const r = buildPlatformRevenue(0, 0, [
      seller('starter', '2026-01-01T00:00:00.000Z'),
      seller('enterprise', '2026-01-01T00:00:00.000Z'),
    ], [], FROM, TO);
    expect(r.subscriptions).toBe(monthlyFeeForTier('starter') + monthlyFeeForTier('enterprise'));
  });

  it('treats a seller with no tier as the default one (no backfill needed)', () => {
    const r = buildPlatformRevenue(0, 0, [seller(undefined, '2026-01-01T00:00:00.000Z')], [], FROM, TO);
    expect(r.subscriptions).toBe(monthlyFeeForTier(undefined));
  });

  it('pro-rates a seller who signed up mid-range, and skips one who signed up after it', () => {
    // Signed up on the 16th → 15 of the 30 days billable.
    const mid = buildPlatformRevenue(0, 0, [seller('starter', '2026-07-16T09:00:00.000Z')], [], FROM, TO);
    expect(mid.subscriptions).toBeCloseTo(monthlyFeeForTier('starter') / 2, 1);
    expect(mid.subscribers).toBe(1);

    const later = buildPlatformRevenue(0, 0, [seller('starter', '2026-08-05T09:00:00.000Z')], [], FROM, TO);
    expect(later.subscriptions).toBe(0);
    expect(later.subscribers).toBe(0);
  });

  it('counts only the MARGIN on ad spend as income — the spend itself is pass-through', () => {
    const r = buildPlatformRevenue(0, 0, [], [campaign('c1', 3000, '2026-06-01T00:00:00.000Z')], FROM, TO);
    expect(r.adSpend).toBeGreaterThan(0);
    expect(r.adMargin).toBeCloseTo(r.adSpend * (AD_PLATFORM_MARGIN_PERCENT / 100), 1);
    // The spend never lands in `total` — only the margin does.
    expect(r.total).toBe(r.adMargin);
    expect(r.adMarginRate).toBe(AD_PLATFORM_MARGIN_PERCENT);
  });

  it('bills no ad margin for a campaign that never ran inside the range', () => {
    const r = buildPlatformRevenue(0, 0, [], [campaign('c1', 3000, '2026-09-01T00:00:00.000Z')], FROM, TO);
    expect(r.adSpend).toBe(0);
    expect(r.adMargin).toBe(0);
  });

  it('is zero across the board with no sellers, no campaigns and no sales', () => {
    const r = buildPlatformRevenue(0, 0, [], [], FROM, TO);
    expect(r).toMatchObject({ commission: 0, subscriptions: 0, adSpend: 0, adMargin: 0, total: 0, subscribers: 0 });
  });
});
