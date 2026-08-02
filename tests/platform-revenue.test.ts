import { describe, it, expect } from 'vitest';
import { buildPlatformRevenue } from '../src/lib/platform-revenue.js';
import { toAgorot } from '../src/lib/money.js';
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
    expect(r.commissionAgorot).toBe(1000);
    expect(r.subscriptionsAgorot).toBe(toAgorot(monthlyFeeForTier('starter'))); // full 30-day month
    expect(r.adMarginAgorot).toBe(0);
    expect(r.totalAgorot).toBe(1000 + toAgorot(monthlyFeeForTier('starter')));
    expect(r.subscribers).toBe(1);
  });

  it('bills each seller at their OWN tier fee, not one platform number', () => {
    const r = buildPlatformRevenue(0, 0, [
      seller('starter', '2026-01-01T00:00:00.000Z'),
      seller('enterprise', '2026-01-01T00:00:00.000Z'),
    ], [], FROM, TO);
    expect(r.subscriptionsAgorot).toBe(toAgorot(monthlyFeeForTier('starter')) + toAgorot(monthlyFeeForTier('enterprise')));
  });

  it('treats a seller with no tier as the default one (no backfill needed)', () => {
    const r = buildPlatformRevenue(0, 0, [seller(undefined, '2026-01-01T00:00:00.000Z')], [], FROM, TO);
    expect(r.subscriptionsAgorot).toBe(toAgorot(monthlyFeeForTier(undefined)));
  });

  it('pro-rates a seller who signed up mid-range, and skips one who signed up after it', () => {
    // Signed up on the 16th → 15 of the 30 days billable.
    const mid = buildPlatformRevenue(0, 0, [seller('starter', '2026-07-16T09:00:00.000Z')], [], FROM, TO);
    expect(mid.subscriptionsAgorot).toBeCloseTo(toAgorot(monthlyFeeForTier('starter')) / 2, -1);
    expect(mid.subscribers).toBe(1);

    const later = buildPlatformRevenue(0, 0, [seller('starter', '2026-08-05T09:00:00.000Z')], [], FROM, TO);
    expect(later.subscriptionsAgorot).toBe(0);
    expect(later.subscribers).toBe(0);
  });

  it('counts only the MARGIN on ad spend as income — the spend itself is pass-through', () => {
    const r = buildPlatformRevenue(0, 0, [], [campaign('c1', 3000, '2026-06-01T00:00:00.000Z')], FROM, TO);
    expect(r.adSpendAgorot).toBeGreaterThan(0);
    expect(r.adMarginAgorot).toBeCloseTo(r.adSpendAgorot * (AD_PLATFORM_MARGIN_PERCENT / 100), -1);
    // The spend never lands in `total` — only the margin does.
    expect(r.totalAgorot).toBe(r.adMarginAgorot);
    expect(r.adMarginRate).toBe(AD_PLATFORM_MARGIN_PERCENT);
  });

  it('bills no ad margin for a campaign that never ran inside the range', () => {
    const r = buildPlatformRevenue(0, 0, [], [campaign('c1', 3000, '2026-09-01T00:00:00.000Z')], FROM, TO);
    expect(r.adSpendAgorot).toBe(0);
    expect(r.adMarginAgorot).toBe(0);
  });

  it('is zero across the board with no sellers, no campaigns and no sales', () => {
    const r = buildPlatformRevenue(0, 0, [], [], FROM, TO);
    expect(r).toMatchObject({ commissionAgorot: 0, subscriptionsAgorot: 0, adSpendAgorot: 0, adMarginAgorot: 0, totalAgorot: 0, subscribers: 0 });
  });
});
