import type { AdCampaign } from './ad-campaigns.js';
import type { TierAccrual } from './seller-auth.js';
import { campaignStatsInRange } from './ad-metrics.js';
import { AD_PLATFORM_MARGIN_PERCENT, monthlyFeeForTier } from './pricing.js';
import { toAgorot } from './money.js';

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

/** What the subscription line needs, per tier rather than per seller — see
 *  `seller-auth.ts#getSubscriptionAccrual`, which is the `GROUP BY` this shape comes out of. */
export type RevenueTierInput = TierAccrual;

/**
 * **Every money figure here is integer agorot, and this module is where two units meet.**
 *
 * The commission arrives from `platform-performance.ts`, which sums order lines and is therefore
 * agorot (§7.7). The other two streams do not come from orders at all: subscription fees are ILS
 * in `pricing.ts` and campaign spend is ILS in `ad-metrics.ts`, because neither module has moved.
 * Adding those numbers to the commission as they stand would book a ₪99 monthly fee as 99 agorot
 * and quietly understate the platform's own income by a factor of a hundred on the one screen that
 * reports it. They convert on the way in; the whole record leaves in one unit.
 */
export interface PlatformRevenue {
  /** Sales commission accrued in range (from the performance summary). */
  commissionAgorot: number;
  /** Blended commission rate as % of GMV — carried through for the UI label. */
  commissionRate: number;
  /** Subscription fees accrued in range, pro-rated by day. */
  subscriptionsAgorot: number;
  /** Sellers who accrued any subscription fee in range (i.e. existed during it). */
  subscribers: number;
  /** Real ad spend billed onward to sellers in range — pass-through, not income. */
  adSpendAgorot: number;
  /** Platform margin on that spend — this IS income. */
  adMarginAgorot: number;
  /** The margin percent applied, for the UI label. */
  adMarginRate: number;
  /** commission + subscriptions + adMargin. */
  totalAgorot: number;
}

/** A month of subscription is billed as 30 days, so a partial range accrues pro-rata.
 *  Using the real calendar month length instead would make an identical 7-day window
 *  worth a different amount in February than in March — noise in a range-comparison view.
 *
 *  Note: the free trial (14–30d, AI_INSTRUCTIONS.md → Business model) is NOT modelled —
 *  no trial-end date is stored on Seller yet, so a brand-new account accrues from day one.
 *  That makes this figure an upper bound until the trial field exists. */
const BILLING_DAYS_PER_MONTH = 30;

export function buildPlatformRevenue(
  /** Already agorot — it comes straight off `PerformanceSummary.platformCommissionAgorot`. */
  commissionAgorot: number,
  commissionRate: number,
  /** Per TIER, not per seller: the fee is a property of the tier and the only per-seller input is
   *  how many days of the range the account existed for, which the query already summed
   *  (`seller-auth.ts#getSubscriptionAccrual`). This used to be the whole roster, looped here. */
  tiers: RevenueTierInput[],
  campaigns: AdCampaign[],
  fromISO: string,
  toISO: string,
): PlatformRevenue {
  let subscriptions = 0;
  let subscribers = 0;
  for (const tier of tiers) {
    if (tier.billableDays <= 0) continue;
    subscribers += tier.subscribers;
    subscriptions += (monthlyFeeForTier(tier.tier) * tier.billableDays) / BILLING_DAYS_PER_MONTH;
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

  // The three ILS accumulators above cross into agorot HERE, once each, and nothing downstream
  // holds a fractional amount again.
  const subsAgorot = toAgorot(subscriptions);
  const spendAgorot = toAgorot(paidToNetworks);
  const marginAgorot = toAgorot(charged) - spendAgorot;

  return {
    commissionAgorot,
    commissionRate,
    subscriptionsAgorot: subsAgorot,
    subscribers,
    adSpendAgorot: spendAgorot,
    adMarginAgorot: marginAgorot,
    adMarginRate: AD_PLATFORM_MARGIN_PERCENT,
    totalAgorot: commissionAgorot + subsAgorot + marginAgorot,
  };
}
