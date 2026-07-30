import type { AdCampaign } from './ad-campaigns.js';
import { campaignStatsInRange } from './ad-metrics.js';
import { daysInRangeInclusive } from './date-range.js';
import { AD_PLATFORM_MARGIN_PERCENT, monthlyFeeForTier } from './pricing.js';
import { roundMoney, sumMoney } from './money.js';

// Where the platform's money actually comes from, for one date range
// (CURRENT_TASK.md → סשן ב׳ item 2). The performance tab used to show a single
// "commission" figure, which is only one of THREE independent income streams:
//
//   1. Sales commission  — a % of GMV, per the seller's tier. Computed by
//      platform-performance.ts (per store, per that store's own tier) and passed
//      in here rather than recomputed, so the two views can never disagree.
//   2. Subscriptions     — each seller's fixed monthly tier fee.
//   3. Campaign margin   — the disclosed markup on seller boost spend. The spend
//      itself is a pass-through to Google/Meta and is NOT income (see pricing.ts
//      → AD_PLATFORM_MARGIN_PERCENT); only the margin is.
//
// Platform BRAND campaigns (brand-campaigns.ts) are deliberately absent: those
// are the platform advertising itself, an expense, not a revenue stream.
//
// Pure given its inputs (no file reads) — the caller supplies the already-read
// seller + campaign lists, so this is directly testable and stays cheap at the
// call sites that already hold both lists.

/** The subset of a Seller this module needs — kept structural so tests don't build full records. */
export interface RevenueSellerInput {
  tier?: string;
  createdAt: string;
}

export interface PlatformRevenue {
  /** Sales commission accrued in range (from the performance summary). */
  commission: number;
  /** Blended commission rate as % of GMV — carried through for the UI label. */
  commissionRate: number;
  /** Subscription fees accrued in range, pro-rated by day. */
  subscriptions: number;
  /** Sellers who accrued any subscription fee in range (i.e. existed during it). */
  subscribers: number;
  /** Real ad spend billed onward to sellers in range — pass-through, not income. */
  adSpend: number;
  /** Platform margin on that spend — this IS income. */
  adMargin: number;
  /** The margin percent applied, for the UI label. */
  adMarginRate: number;
  /** commission + subscriptions + adMargin. */
  total: number;
}

/** A month of subscription is billed as 30 days, so a partial range accrues pro-rata.
 *  Using the real calendar month length instead would make an identical 7-day window
 *  worth a different amount in February than in March — noise in a range-comparison view. */
const BILLING_DAYS_PER_MONTH = 30;

/** Days of [fromISO,toISO] during which this seller's account existed. A seller who
 *  registered mid-range is only billed from their signup day, not for the whole window.
 *
 *  Note: the free trial (14–30d, AI_INSTRUCTIONS.md → Business model) is NOT modelled —
 *  no trial-end date is stored on Seller yet, so a brand-new account accrues from day one.
 *  That makes this figure an upper bound until the trial field exists. */
function billableDays(seller: RevenueSellerInput, fromISO: string, toISO: string): number {
  const signup = seller.createdAt.slice(0, 10);
  if (signup > toISO) return 0;
  const start = signup > fromISO ? signup : fromISO;
  return daysInRangeInclusive(start, toISO);
}

export function buildPlatformRevenue(
  commission: number,
  commissionRate: number,
  sellers: RevenueSellerInput[],
  campaigns: AdCampaign[],
  fromISO: string,
  toISO: string,
): PlatformRevenue {
  let subscriptions = 0;
  let subscribers = 0;
  for (const seller of sellers) {
    const days = billableDays(seller, fromISO, toISO);
    if (days <= 0) continue;
    subscribers++;
    subscriptions += (monthlyFeeForTier(seller.tier) * days) / BILLING_DAYS_PER_MONTH;
  }

  // Only seller-owned boost campaigns are billed onward — that's every row in
  // ad-campaigns.json by definition (the platform-funded baseline has no row).
  //
  // Two figures, and mixing them up would book the platform's own pass-through as income: what
  // the SELLER was charged, and what of that reached Google/Meta. The management fee comes out of
  // the budget (owner's decision, 2026-07-30), so the income is exactly the difference — taken
  // from the same numbers the seller's dashboard shows him rather than re-derived from a
  // percentage here, which is how the two would drift apart.
  let charged = 0;
  let paidToNetworks = 0;
  for (const campaign of campaigns) {
    const stats = campaignStatsInRange(campaign, fromISO, toISO);
    charged += stats.spend;
    paidToNetworks += stats.adSpend;
  }

  const subs = roundMoney(subscriptions);
  const spend = roundMoney(paidToNetworks);
  const margin = roundMoney(charged - paidToNetworks);

  return {
    commission,
    commissionRate,
    subscriptions: subs,
    subscribers,
    adSpend: spend,
    adMargin: margin,
    adMarginRate: AD_PLATFORM_MARGIN_PERCENT,
    total: sumMoney([commission, subs, margin]),
  };
}
