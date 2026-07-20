import crypto from 'node:crypto';
import type { AdCampaign } from './ad-campaigns.js';
import type { BrandCampaign } from './brand-campaigns.js';
import { daysInRangeInclusive, toISODate } from './date-range.js';

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

/** ISO date `days` after `iso` (local calendar, DST-safe via Date arithmetic). */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return toISODate(dt);
}

/** The minimal shape a campaign needs for run-period math — shared by boost
 *  (AdCampaign) and brand (BrandCampaign) campaigns so both freeze on pause. */
interface Runnable {
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  durationDays?: number;
}

/** A campaign's real run period — the window over which it actually accrued
 *  exposure. It starts when it was created and ENDS at whichever comes first:
 *  the day it was paused (frozen there — pausing stops future spend but never
 *  erases what already ran, CURRENT_TASK.md item 1), the end of its fixed
 *  duration, or `todayISO`. A paused campaign without an explicit `pausedAt`
 *  (legacy rows) falls back to `updatedAt`. */
function runPeriod(c: Runnable, todayISO: string): { start: string; end: string } {
  const start = c.createdAt.slice(0, 10);
  let end = todayISO;
  if (c.status === 'paused') {
    const pausedISO = (c.pausedAt ?? c.updatedAt).slice(0, 10);
    if (pausedISO < end) end = pausedISO;
  }
  if (c.durationDays) {
    const durEnd = addDaysISO(start, c.durationDays - 1);
    if (durEnd < end) end = durEnd;
  }
  if (end < start) end = start;
  return { start, end };
}

/** Active days of the campaign's run period that fall inside the window [from,to].
 *  Zero when the window lies entirely before launch or after it stopped. */
function overlapDays(c: Runnable, from: string, to: string): number {
  const { start, end } = runPeriod(c, to);
  const s = start > from ? start : from;
  const e = end < to ? end : to;
  return s > e ? 0 : daysInRangeInclusive(s, e);
}

/** Seeded, deterministic metrics for a campaign that ran `days` active days.
 *  Shared by the lifetime and windowed views so the two never disagree on rate. */
function accrue(campaign: AdCampaign, days: number): RangeStat {
  if (days <= 0) return ZERO;
  const rand = frac('camp:' + campaign.id);
  const spend = (campaign.monthlyBudget / 30) * days;
  const cpm = campaign.platform === 'google' ? 18 + rand * 14
    : campaign.platform === 'meta' ? 12 + rand * 10
    : 15 + rand * 12; // 'both' = blended Google+Meta band
  const imp = Math.round((spend / cpm) * 1000);
  const ctr = 1.2 + rand * 2.3; // %
  const clicks = Math.round(imp * (ctr / 100));
  const roas = Math.round((1.8 + rand * 3.2) * 100) / 100; // simulated revenue / spend
  return { impressions: imp, clicks, ctr: ctrOf(imp, clicks), spend: Math.round(spend * 100) / 100, conversions: 0, roas };
}

/** Metrics accrued during the overlap of the picked window [from,to] with the
 *  campaign's real run period. A paused campaign still reports the days it ran
 *  before it was paused (item 1) — it only reports ZERO for a window that lies
 *  entirely after it stopped, or entirely before it launched. */
export function campaignStatsInRange(campaign: AdCampaign, from: string, to: string): RangeStat {
  return accrue(campaign, overlapDays(campaign, from, to));
}

/** Lifetime ("since launch") totals — what this specific campaign has achieved
 *  over its whole run period, independent of any picked window (CURRENT_TASK.md
 *  item 3). This is the stable per-campaign headline; the window picker layers a
 *  recent-activity view on top of it. */
export function campaignLifetimeStats(campaign: AdCampaign, today: Date = new Date()): RangeStat {
  const { start, end } = runPeriod(campaign, toISODate(today));
  return accrue(campaign, daysInRangeInclusive(start, end));
}

/** The campaign's run period as ISO dates + active-day count — for the card's
 *  "running since / ran X days" label. */
export function campaignRunPeriod(campaign: AdCampaign, today: Date = new Date()): { start: string; end: string; days: number } {
  const { start, end } = runPeriod(campaign, toISODate(today));
  return { start, end, days: daysInRangeInclusive(start, end) };
}

/** A campaign decorated with its mock stats for the chosen window (or lifetime
 *  totals when `range` is undefined) plus its run period — the exact response
 *  shape both the seller and admin ad-campaign routes return, kept here so they
 *  can't drift. */
export function withCampaignStats(campaign: AdCampaign, range?: { from: string; to: string }) {
  return {
    ...campaign,
    stats: range ? campaignStatsInRange(campaign, range.from, range.to) : campaignLifetimeStats(campaign),
    runPeriod: campaignRunPeriod(campaign),
  };
}

export function brandStatsInRange(campaign: BrandCampaign, from: string, to: string): RangeStat {
  const days = overlapDays(campaign, from, to);
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
