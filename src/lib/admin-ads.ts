import type { Store } from './stores.js';
import type { AdCampaign } from './ad-campaigns.js';
import type { BrandCampaign } from './brand-campaigns.js';
import type { PlatformAdSettings } from './platform-ads.js';
import { baselineImpressionsInRange, campaignStatsInRange, brandStatsInRange } from './ad-metrics.js';
import { fromAgorot, roundMoney } from './money.js';
import { presetRange } from './date-range.js';

// Platform-level advertising overview for the admin Advertising tab
// (CURRENT_TASK.md → סשן ב׳). Pure: takes already-fetched data + settings and
// packages the numbers the owner needs to understand "how is the whole app being
// advertised right now" — no fs, no JSON reads of its own (same discipline as
// admin-stats.ts). Everything here is either a real config/data fact
// (connections, feed size, promoted stores) or a clearly-labelled mock estimate
// (baseline/boost spend) standing in for a real Google/Meta reporting API.

/** Nominal CPM (ILS per 1000 impressions) used only to turn mock baseline
 *  impressions into an estimated-spend indicator — NOT a real billed rate. */
const BASELINE_CPM = 20;
/** Nominal click-through rate for the baseline campaign — the baseline mock only
 *  models impressions, so a flat CTR turns those into an estimated click count
 *  for the blended PPC snapshot. Estimate only, replaced by real reporting. */
const BASELINE_CTR = 0.015;
/** Per-store exposure is shown as a top-N list, never every store — the cap that
 *  keeps the page bounded at 1000+ stores (full drill-down is the Stores tab). */
const TOP_STORES_LIMIT = 10;

export interface AdConnectionStatus {
  googleTag: boolean;      // a real GTM container id is configured
  metaPixel: boolean;      // a real Meta Pixel id is configured
  feedStores: number;      // stores currently exported in the product feed
  feedProducts: number;    // products currently exported in the product feed
}

export interface BaselineOverview {
  status: 'active' | 'paused';
  lifetimeBudget: number;   // owner-set cap (0 = not set)
  estimatedSpend: number;   // mock, capped at lifetimeBudget when set
  impressions: number;      // mock aggregate across all visible stores
  budgetUsedPct: number;    // 0..100 (0 when no budget set)
}

export interface BoostOverview {
  activeCampaigns: number;
  totalCampaigns: number;
  monthlyBudget: number;    // sum of active campaigns' seller-set budgets
  estimatedSpend: number;   // mock aggregate
  impressions: number;      // mock aggregate
}

export interface BrandOverview {
  activeCampaigns: number;
  totalCampaigns: number;
  monthlyBudget: number;   // sum of active campaigns' budgets
  estimatedSpend: number;  // mock aggregate
  impressions: number;     // mock aggregate
  clicks: number;          // mock aggregate
  conversions: number;     // mock aggregate (store-opens / new buyers attributed)
}

export interface PromotedStoreRow {
  slug: string;
  name: string;
  weight: number;
}

export interface SourceExposure { impressions: number; spend: number }
export interface StoreExposureRow { slug: string; name: string; impressions: number; hasBoost: boolean }

/** The owner's simple exposure view: one platform-wide total, a split by the
 *  three sources, and a bounded top-N per-store list. */
export interface ExposureOverview {
  totalImpressions: number;
  totalSpend: number;
  totalClicks: number;
  bySource: { baseline: SourceExposure; brand: SourceExposure; boost: SourceExposure };
  totalStores: number;              // how many stores are in the feed (top N of this)
  topStores: StoreExposureRow[];    // capped at TOP_STORES_LIMIT — never all stores
}

/** PPC (pay-per-click) snapshot for the PLATFORM'S OWN advertising — baseline +
 *  brand. Deliberately excludes seller-funded boosts: those are the sellers'
 *  money and their own performance, shown separately in `boost`. Mixing them in
 *  would conflate your spend with theirs. All estimates until a real reporting
 *  API is connected. */
export interface PpcSnapshot {
  spend: number;        // total ILS (baseline + brand)
  impressions: number;  // times an ad was shown
  clicks: number;       // times an ad was clicked
  ctr: number;          // click-through rate, % (clicks / impressions)
  cpc: number;          // cost per click, ILS (spend / clicks)
  cpm: number;          // cost per 1000 impressions, ILS
}

export interface PlatformAdOverview {
  connection: AdConnectionStatus;
  baseline: BaselineOverview;
  boost: BoostOverview;
  brand: BrandOverview;
  ppc: PpcSnapshot;
  exposure: ExposureOverview;
  promotedStores: PromotedStoreRow[];
}

export interface PlatformAdInput {
  /** Visible (non-blocked) stores that carry at least one visible product — the exact set the
   *  product feed exports and the baseline campaign covers. */
  feedStores: Store[];
  /** Count of visible products across those stores (feed row count, pre variant-expansion). */
  feedProductCount: number;
  /** Every store (visible or not) — promoted-store list is drawn from here so an owner can still
   *  see a promotion they set on a store that later lost all its products. */
  allStores: Store[];
  campaigns: AdCampaign[];
  brandCampaigns: BrandCampaign[];
  ads: { googleTagId?: string; metaPixelId?: string } | undefined;
  settings: PlatformAdSettings;
  /** Date window all mock metrics are measured over. Defaults to the last 7 days. */
  range?: { from: string; to: string };
}

export function buildPlatformAdOverview(input: PlatformAdInput): PlatformAdOverview {
  const { feedStores, feedProductCount, allStores, campaigns, brandCampaigns, ads, settings } = input;
  const { from, to } = input.range ?? presetRange('7d')!;

  const connection: AdConnectionStatus = {
    googleTag: !!ads?.googleTagId?.trim(),
    metaPixel: !!ads?.metaPixelId?.trim(),
    feedStores: feedStores.length,
    feedProducts: feedProductCount,
  };

  // Baseline: platform-funded exposure every visible store gets automatically,
  // measured over the selected range.
  const baselineImpressions = feedStores.reduce((sum, s) => sum + baselineImpressionsInRange(s.id, from, to), 0);
  const rawBaselineSpend = Math.round((baselineImpressions / 1000) * BASELINE_CPM);
  // The stored knob is integer agorot (platform-ads.ts); every other figure in this overview is
  // ILS, because it is built from ad-metrics.ts. One conversion, at the edge.
  const budget = fromAgorot(settings.lifetimeBudgetAgorot);
  const paused = settings.baselineStatus === 'paused';
  const estimatedSpend = paused ? 0 : budget > 0 ? Math.min(rawBaselineSpend, budget) : rawBaselineSpend;
  const baseline: BaselineOverview = {
    status: settings.baselineStatus,
    lifetimeBudget: budget,
    estimatedSpend,
    impressions: paused ? 0 : baselineImpressions,
    budgetUsedPct: budget > 0 ? Math.min(100, Math.round((estimatedSpend / budget) * 100)) : 0,
  };

  // Boost: seller-funded campaigns. Kept as an AGGREGATE only (never a per-campaign
  // list) so the view stays bounded whether there are 5 boosts or 5000 — the
  // owner sees totals, not a row per seller. A per-store map is accumulated for
  // the per-store exposure view (also bounded, see topStores below).
  const active = campaigns.filter((c) => c.status === 'active');
  // Two different questions, two different bases — and the split is the point:
  //   · what RAN in this window  → every campaign, whatever its status is today. A campaign that
  //     ran nine days and was then cancelled still spent that money, and platform-revenue.ts
  //     bills it that way; filtering to currently-active here made the same window report two
  //     different ad-spend figures on two admin screens.
  //   · what is committed NOW    → only the active ones (count + monthly budget), which is a
  //     forward-looking number and has nothing to do with the window.
  let boostSpend = 0;
  let boostImpressions = 0;
  let boostClicks = 0;
  let boostBudget = 0;
  const boostImpByStore = new Map<string, number>();
  for (const c of campaigns) {
    const stats = campaignStatsInRange(c, from, to);
    // What BOUGHT the exposure, not what the seller was charged for it: this box sits beside the
    // platform's own baseline spend, and the management fee is income, not media. The fee shows up
    // where income belongs — the revenue view (platform-revenue.ts).
    boostSpend += stats.adSpend;
    boostImpressions += stats.impressions;
    boostClicks += stats.clicks;
    boostImpByStore.set(c.storeId, (boostImpByStore.get(c.storeId) ?? 0) + stats.impressions);
  }
  // **Summed in agorot, converted once.** These are the two `+=` in the application that touch a
  // `bigint` column, and `+` on the string `pg` returns for one CONCATENATES rather than adds —
  // '50000' + '50000' is '5000050000', with no type error and no failing render. Integers also
  // mean the total is exact however many campaigns a store runs.
  for (const c of active) boostBudget += c.monthlyBudgetAgorot;
  const boost: BoostOverview = {
    activeCampaigns: active.length,
    totalCampaigns: campaigns.length,
    monthlyBudget: fromAgorot(boostBudget),
    estimatedSpend: Math.round(boostSpend),
    impressions: boostImpressions,
  };

  // Brand: owner-run platform-awareness campaigns (aggregate view).
  // Split on the same two questions as the boost half above, for the same reason: what RAN in
  // this window is every campaign whatever its status is today, and what is committed NOW is
  // only the active ones. Summing the window over `brandActive` alone made a brand campaign the
  // owner paused mid-month take its already-spent budget out of the month's reported figure —
  // the same July window reporting a smaller platform ad cost after the pause than before it,
  // while brandStatsInRange had the right answer all along (it freezes at pausedAt rather than
  // returning zero, ad-metrics.ts#runPeriod).
  const brandActive = brandCampaigns.filter((c) => c.status === 'active');
  let brandSpend = 0;
  let brandImpressions = 0;
  let brandClicks = 0;
  let brandConversions = 0;
  let brandBudget = 0;
  for (const c of brandCampaigns) {
    const stats = brandStatsInRange(c, from, to);
    brandSpend += stats.spend;
    brandImpressions += stats.impressions;
    brandClicks += stats.clicks;
    brandConversions += stats.conversions;
  }
  for (const c of brandActive) brandBudget += c.monthlyBudgetAgorot; // agorot — see the boost sum
  const brand: BrandOverview = {
    activeCampaigns: brandActive.length,
    totalCampaigns: brandCampaigns.length,
    monthlyBudget: fromAgorot(brandBudget),
    estimatedSpend: Math.round(brandSpend),
    impressions: brandImpressions,
    clicks: brandClicks,
    conversions: brandConversions,
  };

  // PPC snapshot for the platform's OWN advertising only (baseline + brand) —
  // seller boosts are excluded on purpose (their money, shown in `boost`).
  // Baseline only models impressions, so its clicks come from a nominal CTR.
  // Every divide guards against an empty state.
  const baselineClicks = Math.round(baseline.impressions * BASELINE_CTR);
  const totalSpend = baseline.estimatedSpend + brand.estimatedSpend;
  const totalImpressions = baseline.impressions + brand.impressions;
  const totalClicks = baselineClicks + brand.clicks;
  const ppc: PpcSnapshot = {
    spend: totalSpend,
    impressions: totalImpressions,
    clicks: totalClicks,
    ctr: totalImpressions > 0 ? Math.round((totalClicks / totalImpressions) * 1000) / 10 : 0,
    cpc: totalClicks > 0 ? roundMoney(totalSpend / totalClicks) : 0,
    cpm: totalImpressions > 0 ? roundMoney((totalSpend / totalImpressions) * 1000) : 0,
  };

  // ── Exposure: the owner's simple "where is exposure coming from" view ──
  // Platform-wide total across every source, a 3-way split by source, and a
  // per-store list CAPPED at the top N. The cap is the scalability guarantee —
  // with 1000 stores this stays a 10-row list, never an infinite page (the full
  // per-store drill-down already lives in the Stores tab's performance page).
  const exposure: ExposureOverview = {
    totalImpressions: baseline.impressions + brand.impressions + boost.impressions,
    totalSpend: baseline.estimatedSpend + brand.estimatedSpend + boost.estimatedSpend,
    totalClicks: baselineClicks + brand.clicks + boostClicks,
    bySource: {
      baseline: { impressions: baseline.impressions, spend: baseline.estimatedSpend },
      brand: { impressions: brand.impressions, spend: brand.estimatedSpend },
      boost: { impressions: boost.impressions, spend: boost.estimatedSpend },
    },
    totalStores: feedStores.length,
    topStores: feedStores
      .map((s) => ({
        slug: s.slug,
        name: s.name,
        impressions: (paused ? 0 : baselineImpressionsInRange(s.id, from, to)) + (boostImpByStore.get(s.id) ?? 0),
        hasBoost: boostImpByStore.has(s.id),
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, TOP_STORES_LIMIT),
  };

  const promotedStores: PromotedStoreRow[] = allStores
    .filter((s) => (s.promoWeight ?? 0) > 0)
    .sort((a, b) => (b.promoWeight ?? 0) - (a.promoWeight ?? 0))
    .map((s) => ({ slug: s.slug, name: s.name, weight: s.promoWeight ?? 0 }));

  return { connection, baseline, boost, brand, ppc, exposure, promotedStores };
}
