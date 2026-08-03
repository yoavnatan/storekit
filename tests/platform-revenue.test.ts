import { describe, it, expect } from 'vitest';
import { buildPlatformRevenue } from '../src/lib/platform-revenue.js';
import { toAgorot } from '../src/lib/money.js';
import { AD_PLATFORM_MARGIN_PERCENT, monthlyFeeForTier } from '../src/lib/pricing.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';

const FROM = '2026-07-01';
const TO = '2026-07-30'; // exactly 30 days → one whole billing month

/** One tier's share of the accrual, as `seller-auth.ts#getSubscriptionAccrual` returns it (§3):
 *  the fee is a property of the TIER, and the only per-seller input — how many days of the range
 *  each account existed for — is summed by the query. */
function accrual(tier: string | undefined, billableDays: number, subscribers = 1) {
  return { ...(tier ? { tier } : {}), subscribers, billableDays };
}

function campaign(id: string, budgetIls: number, createdAt: string, over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id,
    storeId: 'st1',
    storeSlug: 'store',
    scope: 'store',
    platform: 'google',
    monthlyBudgetAgorot: toAgorot(budgetIls),
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

describe('buildPlatformRevenue — the three income streams', () => {
  it('adds commission + subscriptions + ad margin, and nothing else', () => {
    const r = buildPlatformRevenue(1000, 11, [accrual('starter', 30)], [], FROM, TO);
    expect(r.commissionAgorot).toBe(1000);
    expect(r.subscriptionsAgorot).toBe(toAgorot(monthlyFeeForTier('starter'))); // full 30-day month
    expect(r.adMarginAgorot).toBe(0);
    expect(r.totalAgorot).toBe(1000 + toAgorot(monthlyFeeForTier('starter')));
    expect(r.subscribers).toBe(1);
  });

  it('bills each seller at their OWN tier fee, not one platform number', () => {
    const r = buildPlatformRevenue(0, 0, [accrual('starter', 30), accrual('enterprise', 30)], [], FROM, TO);
    expect(r.subscriptionsAgorot).toBe(toAgorot(monthlyFeeForTier('starter')) + toAgorot(monthlyFeeForTier('enterprise')));
  });

  it('treats a seller with no tier as the default one (no backfill needed)', () => {
    const r = buildPlatformRevenue(0, 0, [accrual(undefined, 30)], [], FROM, TO);
    expect(r.subscriptionsAgorot).toBe(toAgorot(monthlyFeeForTier(undefined)));
  });

  it('pro-rates a seller who signed up mid-range, and skips one who signed up after it', () => {
    // Signed up on the 16th → 15 of the 30 days billable.
    const mid = buildPlatformRevenue(0, 0, [accrual('starter', 15)], [], FROM, TO);
    // Half a month's fee, within an agora — the pro-rata is a division, so the agora it lands on
    // is a rounding decision and not a drift.
    expect(Math.abs(mid.subscriptionsAgorot - toAgorot(monthlyFeeForTier('starter')) / 2))
      .toBeLessThanOrEqual(1);
    expect(mid.subscribers).toBe(1);

    // A seller who signed up AFTER the range is dropped by the query's own WHERE now, so it never
    // reaches here — what this side still has to hold is that a zero-day row bills nothing and
    // counts nobody, which is what a defensive caller would hand over.
    const later = buildPlatformRevenue(0, 0, [accrual('starter', 0)], [], FROM, TO);
    expect(later.subscriptionsAgorot).toBe(0);
    expect(later.subscribers).toBe(0);
  });

  it('counts only the MARGIN on ad spend as income — the spend itself is pass-through', () => {
    const r = buildPlatformRevenue(0, 0, [], [campaign('c1', 3000, '2026-06-01T00:00:00.000Z')], FROM, TO);
    expect(r.adSpendAgorot).toBeGreaterThan(0);
    // Within ONE agora of `adSpend × 15%`, and that bound is measured rather than guessed: the
    // margin is `toAgorot(charged) − toAgorot(paidToNetworks)`, so it carries exactly two
    // roundings however many campaigns are summed. Across 20,000 synthetic campaigns the booked
    // share of the charge is 13.0435% — precisely 15/115, which is what a fee taken OUT of the
    // budget must come to — and the worst single deviation is 1 agora. A looser tolerance here
    // would let a real drift in the fee base through.
    expect(Math.abs(r.adMarginAgorot - Math.round(r.adSpendAgorot * (AD_PLATFORM_MARGIN_PERCENT / 100))))
      .toBeLessThanOrEqual(1);
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
