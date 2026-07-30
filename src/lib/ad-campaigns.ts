import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AdScopeKind } from './ad-scope-label.js';

const CAMPAIGNS_PATH = path.join(process.cwd(), 'data/ad-campaigns.json');

// Two-tier ads model (see AI_INSTRUCTIONS.md "Ads — two-tier model"): every
// product is already in the platform-funded baseline campaign automatically
// (no row here for that — it's not seller-owned). A row here is only the
// seller-funded "boost" tier — a real Google Ads/Meta Marketing API
// integration is not wired up yet (no API keys/business accounts), so
// `monthlyBudget` is a target the seller sets and ad-metrics.ts
// (campaignLifetimeStats / campaignStatsInRange) fabricates plausible, stable
// performance numbers from it. No real charge happens — nothing here moves
// money, so this intentionally skips the money-changes-need-a-mutex/Vitest rule
// that applies to actual payment code.
export interface AdCampaign {
  id: string;
  storeId: string;
  storeSlug: string;
  /** What the boost advertises. 'product' (exactly one) and 'products' (several) come from the
   *  SAME picker — the seller ticks a list — and are normalized apart in ad-campaign-input.ts so
   *  a single-product campaign keeps the row shape it has always had and every existing reader
   *  keeps working (Hard rules → backward-compatible/additive). */
  scope: AdScopeKind;
  /** Single-product scope only — kept as the flat pair it has always been. */
  productId?: string;
  productName?: string;
  /** 'products' scope: the seller's picks, in pick order. Names are a snapshot taken at launch
   *  (same as productName always has been) — a later rename doesn't rewrite a campaign card. */
  productIds?: string[];
  productNames?: string[];
  /** 'categories' scope: the categories the seller picked, NOT flattened downward. A category's
   *  descendants are resolved when the campaign is handed to Google/Meta, off the live tree —
   *  storing a flattened copy here would go stale the moment the seller reshapes the tree. */
  categoryIds?: string[];
  categoryNames?: string[];
  // 'both' = one campaign running on Google + Meta together (the budget is
  // split across the two networks). See ad-metrics.ts for its blended CPM.
  platform: 'google' | 'meta' | 'both';
  monthlyBudget: number; // ILS
  // Seller-chosen run length in days; omitted = ongoing until paused/deleted.
  durationDays?: 7 | 14 | 30;
  // Seller-chosen broad audience segment. The platform still manages the fine
  // targeting + creative automatically (see adBudgetHint) — this only picks the
  // coarse demographic band. 'all' on a field = no restriction on that field.
  audience?: { gender: AdGender; age: AdAgeRange };
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
  // When the campaign was last paused. Pausing FREEZES accrued metrics at this
  // moment instead of erasing them (CURRENT_TASK.md item 1) — ad-metrics.ts reads
  // it to bound the run period. Cleared on resume. Absent on legacy rows (they
  // fall back to updatedAt).
  pausedAt?: string;
  /** Set when the PLATFORM paused it rather than the seller (ad-campaign-health.ts):
   *   'unavailable'  = nothing it advertises is on the storefront any more — a human took it
   *                    down, so only a human puts it back.
   *   'out-of-stock' = everything in it is sold out — temporary, and the same sweep resumes the
   *                    campaign by itself once stock returns.
   *  Cleared on resume, so a campaign only ever carries the reason for the pause it is currently
   *  in, and the distinction is what tells the resume guard which pauses a click may undo. */
  pausedReason?: 'unavailable' | 'out-of-stock';
  /** When the seller (or the admin) cancelled it. A cancelled campaign is NOT deleted: it stops,
   *  leaves the live list and moves to the history block — because the money it already spent is
   *  a fact. Erasing the row erased that fact, and since every reported figure is derived from
   *  the campaign list (platform-revenue.ts sums campaignStatsInRange over it), cancelling a
   *  campaign today silently rewrote what LAST month's ad spend had been. A record that moves
   *  money can be closed; it cannot be un-happened. */
  archivedAt?: string;
}

export type AdGender = 'all' | 'women' | 'men';
// age = the product's target age_group (who it's FOR), a standard feed attribute
// — NOT a viewer age band. See audience-infer.ts#inferAgeGroup for why.
export type AdAgeRange = 'all' | 'infant' | 'kids' | 'adult';
export const AD_DURATION_OPTIONS: readonly (7 | 14 | 30)[] = [7, 14, 30];
export const AD_AGE_OPTIONS: readonly AdAgeRange[] = ['all', 'infant', 'kids', 'adult'];

export type CreateCampaignInput = Pick<AdCampaign, 'storeId' | 'storeSlug' | 'scope' | 'platform' | 'monthlyBudget'> &
  Partial<Pick<AdCampaign,
    'productId' | 'productName' | 'productIds' | 'productNames' |
    'categoryIds' | 'categoryNames' | 'durationDays' | 'audience'>>;

/** Coerce untrusted request input to a valid duration, or undefined (= ongoing). */
export function parseDuration(v: unknown): (7 | 14 | 30) | undefined {
  return AD_DURATION_OPTIONS.includes(v as 7) ? (v as 7 | 14 | 30) : undefined;
}

/** Coerce untrusted request input to a valid audience segment. A fully-open
 *  segment (all/all) is treated as no targeting and returns undefined. */
export function parseAudience(v: unknown): { gender: AdGender; age: AdAgeRange } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { gender?: unknown; age?: unknown };
  const gender: AdGender = o.gender === 'women' || o.gender === 'men' ? o.gender : 'all';
  const age: AdAgeRange = AD_AGE_OPTIONS.includes(o.age as AdAgeRange) ? (o.age as AdAgeRange) : 'all';
  if (gender === 'all' && age === 'all') return undefined;
  return { gender, age };
}

function readAll(): AdCampaign[] {
  try { return JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, 'utf8')) as AdCampaign[]; }
  catch { return []; }
}

function writeAll(campaigns: AdCampaign[]): void {
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(campaigns, null, 2));
}

/** Every campaign across all stores — for the admin's platform-wide advertising overview. */
export function getAllCampaigns(): AdCampaign[] {
  return readAll();
}

/** A store's LIVE campaigns — cancelled ones are history and come from getArchivedByStoreId. */
export function getCampaignsByStoreId(storeId: string): AdCampaign[] {
  return byStore(storeId).filter((c) => !c.archivedAt);
}

/** The cancelled ones, newest first. Read-only everywhere: nothing may be resumed or re-budgeted
 *  out of here, it exists to answer "what did I run, and what did it cost". */
export function getArchivedByStoreId(storeId: string): AdCampaign[] {
  return byStore(storeId).filter((c) => !!c.archivedAt);
}

function byStore(storeId: string): AdCampaign[] {
  return readAll()
    .filter((c) => c.storeId === storeId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function createCampaign(input: CreateCampaignInput): AdCampaign {
  const all = readAll();
  const now = new Date().toISOString();
  const campaign: AdCampaign = {
    id: crypto.randomUUID(),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  all.push(campaign);
  writeAll(all);
  return campaign;
}

export function updateCampaign(id: string, storeId: string, updates: Partial<Pick<AdCampaign, 'monthlyBudget' | 'status' | 'pausedReason'>>): AdCampaign | undefined {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id && c.storeId === storeId);
  if (idx === -1) return undefined;
  const prev = all[idx]!;
  // History is read-only, and this is the only place that could change it. A campaign in the
  // history block has stopped for good: re-budgeting it would rewrite a figure already reported,
  // and resuming it would put a row nobody can see back into circulation.
  if (prev.archivedAt) return undefined;
  const now = new Date().toISOString();
  const next: AdCampaign = { ...prev, ...updates, updatedAt: now };
  // Stamp/clear the pause moment on a real status transition so metrics freeze
  // at the pause and resume cleanly — but a plain budget edit must not disturb it.
  if (updates.status === 'paused' && prev.status !== 'paused') next.pausedAt = now;
  else if (updates.status === 'active') { delete next.pausedAt; delete next.pausedReason; }
  all[idx] = next;
  writeAll(all);
  return all[idx];
}

/** Cancel a campaign: it stops, and it stays. There is deliberately NO function here that
 *  removes a campaign row — the spend it accrued is part of a month's reported figures, and a
 *  delete would rewrite them after the fact. Stopping it is a status change; forgetting it is
 *  not something a dashboard button may do. */
export function archiveCampaign(id: string, storeId: string): AdCampaign | undefined {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id && c.storeId === storeId);
  if (idx === -1) return undefined;
  const prev = all[idx]!;
  if (prev.archivedAt) return prev; // idempotent — a double click cancels once
  const now = new Date().toISOString();
  // Paused as well as archived: `pausedAt` is what bounds the run period, so the metrics freeze
  // at the cancellation instead of accruing forever (ad-metrics.ts#runPeriod).
  all[idx] = { ...prev, status: 'paused', pausedAt: prev.pausedAt ?? now, archivedAt: now, updatedAt: now };
  writeAll(all);
  return all[idx];
}
