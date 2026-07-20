import crypto from 'node:crypto';
import type { AdCampaign } from './ad-campaigns.js';
import type { BrandCampaign } from './brand-campaigns.js';
import { daysInRangeInclusive } from './date-range.js';

// Range-aware MOCK ad metrics (CURRENT_TASK.md → סשן ב׳). Deterministic — seeded
// per entity so numbers stay stable across reloads — and O(1) per entity (a
// seeded daily rate × the number of days in the range, NOT a per-day loop), so
// it scales to thousands of stores/campaigns without a per-day×per-entity blowup.
// Stands in for a real Google/Meta reporting API's date-range query until one is
// connected (see GO_LIVE_CHECKLIST.md). Nothing here moves money.

/** Deterministic 0..1 from a seed string. */
function frac(seed: string): number {
  return crypto.createHash('sha256').update(seed).digest().readUInt32BE(0) / 0xffffffff;
}

export interface RangeStat { impressions: number; clicks: number; ctr: number; spend: number; conversions: number; roas: number }
const ZERO: RangeStat = { impressions: 0, clicks: 0, ctr: 0, spend: 0, conversions: 0, roas: 0 };

/** Click-through rate % from impressions/clicks, guarded against divide-by-zero. */
function ctrOf(impressions: number, clicks: number): number {
  return impressions > 0 ? Math.round((clicks / impressions) * 1000) / 10 : 0;
}

/** Baseline (platform-funded) impressions a store accrues over the range — a
 *  seeded per-day rate × the range length. */
export function baselineImpressionsInRange(storeId: string, from: string, to: string): number {
  const perDay = 15 + frac('base:' + storeId) * 75; // ~15–90 impressions/day
  return Math.round(perDay * daysInRangeInclusive(from, to));
}

/** Days of [from,to] during which a campaign created at `createdAt` was live. A
 *  campaign contributes nothing to a range that ends before it existed. */
function activeDaysInRange(createdAt: string, from: string, to: string): number {
  const created = createdAt.slice(0, 10);
  const start = created > from ? created : from;
  if (start > to) return 0;
  return daysInRangeInclusive(start, to);
}

export function campaignStatsInRange(campaign: AdCampaign, from: string, to: string): RangeStat {
  if (campaign.status === 'paused') return ZERO;
  const days = activeDaysInRange(campaign.createdAt, from, to);
  if (days === 0) return ZERO;
  const rand = frac('camp:' + campaign.id);
  const spend = (campaign.monthlyBudget / 30) * days;
  const cpm = campaign.platform === 'google' ? 18 + rand * 14
    : campaign.platform === 'meta' ? 12 + rand * 10
    : 15 + rand * 12; // 'both' = blended Google+Meta band
  const impressions = (spend / cpm) * 1000;
  const ctr = 1.2 + rand * 2.3; // %
  const imp = Math.round(impressions);
  const clicks = Math.round(impressions * (ctr / 100));
  const roas = Math.round((1.8 + rand * 3.2) * 100) / 100; // simulated revenue / spend
  return { impressions: imp, clicks, ctr: ctrOf(imp, clicks), spend: Math.round(spend * 100) / 100, conversions: 0, roas };
}

export function brandStatsInRange(campaign: BrandCampaign, from: string, to: string): RangeStat {
  if (campaign.status === 'paused') return ZERO;
  const days = activeDaysInRange(campaign.createdAt, from, to);
  if (days === 0) return ZERO;
  const rand = frac('brand:' + campaign.id);
  const spend = (campaign.monthlyBudget / 30) * days;
  const cpm = campaign.platform === 'google' ? 10 + rand * 8 : 8 + rand * 7; // brand/awareness runs cheaper
  const impressions = (spend / cpm) * 1000;
  const ctr = 0.7 + rand * 1.6; // %
  const imp = Math.round(impressions);
  const clicks = Math.round(impressions * (ctr / 100));
  return {
    impressions: imp,
    clicks,
    ctr: ctrOf(imp, clicks),
    spend: Math.round(spend * 100) / 100,
    conversions: Math.round(clicks * (0.02 + rand * 0.05)), // 2%–7% of clicks act
    roas: 0, // brand/awareness has no direct revenue attribution modelled
  };
}
