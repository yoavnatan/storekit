import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  scope: 'store' | 'product';
  productId?: string;
  productName?: string;
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
}

export type AdGender = 'all' | 'women' | 'men';
// age = the product's target age_group (who it's FOR), a standard feed attribute
// — NOT a viewer age band. See audience-infer.ts#inferAgeGroup for why.
export type AdAgeRange = 'all' | 'infant' | 'kids' | 'adult';
export const AD_DURATION_OPTIONS: readonly (7 | 14 | 30)[] = [7, 14, 30];
export const AD_AGE_OPTIONS: readonly AdAgeRange[] = ['all', 'infant', 'kids', 'adult'];

export type CreateCampaignInput = Pick<AdCampaign, 'storeId' | 'storeSlug' | 'scope' | 'platform' | 'monthlyBudget'> &
  Partial<Pick<AdCampaign, 'productId' | 'productName' | 'durationDays' | 'audience'>>;

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

export function getCampaignsByStoreId(storeId: string): AdCampaign[] {
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

export function updateCampaign(id: string, storeId: string, updates: Partial<Pick<AdCampaign, 'monthlyBudget' | 'status'>>): AdCampaign | undefined {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id && c.storeId === storeId);
  if (idx === -1) return undefined;
  const prev = all[idx]!;
  const now = new Date().toISOString();
  const next: AdCampaign = { ...prev, ...updates, updatedAt: now };
  // Stamp/clear the pause moment on a real status transition so metrics freeze
  // at the pause and resume cleanly — but a plain budget edit must not disturb it.
  if (updates.status === 'paused' && prev.status !== 'paused') next.pausedAt = now;
  else if (updates.status === 'active') delete next.pausedAt;
  all[idx] = next;
  writeAll(all);
  return all[idx];
}

export function deleteCampaign(id: string, storeId: string): boolean {
  const all = readAll();
  const next = all.filter((c) => !(c.id === id && c.storeId === storeId));
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

// Deterministic per-entity "random" (seeded by id) so numbers stay stable across
// reloads instead of jumping every render — stands in for a real ad platform's
// reporting API until one is connected. Per-campaign metrics live in
// ad-metrics.ts (range- and lifetime-aware); this only seeds the baseline.
function seededFraction(seed: string): number {
  const hash = crypto.createHash('sha256').update(seed).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

/** Baseline (platform-funded) campaign exposure — every store gets this automatically, seeded by storeId so it stays stable and roughly scales with how long the store has existed isn't modeled (no per-store creation date threaded through here); a flat plausible daily range is enough for a "you're already getting exposure" indicator. */
export function getMockBaselineImpressions(storeId: string): number {
  const rand = seededFraction(storeId);
  return Math.round(400 + rand * 2200);
}
