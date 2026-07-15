import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CAMPAIGNS_PATH = path.join(process.cwd(), 'data/ad-campaigns.json');

// Two-tier ads model (see AI_INSTRUCTIONS.md "Ads — two-tier model"): every
// product is already in the platform-funded baseline campaign automatically
// (no row here for that — it's not seller-owned). A row here is only the
// seller-funded "boost" tier — a real Google Ads/Meta Marketing API
// integration is not wired up yet (no API keys/business accounts), so
// `monthlyBudget` is a target the seller sets and `getMockCampaignStats()`
// below fabricates plausible, stable performance numbers from it. No real
// charge happens — nothing here moves money, so this intentionally skips the
// money-changes-need-a-mutex/Vitest rule that applies to actual payment code.
export interface AdCampaign {
  id: string;
  storeId: string;
  storeSlug: string;
  scope: 'store' | 'product';
  productId?: string;
  productName?: string;
  platform: 'google' | 'meta';
  monthlyBudget: number; // ILS
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
}

export type CreateCampaignInput = Pick<AdCampaign, 'storeId' | 'storeSlug' | 'scope' | 'platform' | 'monthlyBudget'> &
  Partial<Pick<AdCampaign, 'productId' | 'productName'>>;

function readAll(): AdCampaign[] {
  try { return JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, 'utf8')) as AdCampaign[]; }
  catch { return []; }
}

function writeAll(campaigns: AdCampaign[]): void {
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(campaigns, null, 2));
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
  all[idx] = { ...all[idx]!, ...updates, updatedAt: new Date().toISOString() };
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

export interface MockCampaignStats {
  impressions: number;
  clicks: number;
  ctr: number;   // %
  spend: number; // ILS, <= monthlyBudget (pro-rated by days running this month)
  roas: number;  // simulated revenue attributed / spend
}

// Deterministic per-campaign "random" (seeded by id) so numbers stay stable
// across reloads instead of jumping every render — stands in for a real ad
// platform's reporting API until one is connected.
function seededFraction(seed: string): number {
  const hash = crypto.createHash('sha256').update(seed).digest();
  return hash.readUInt32BE(0) / 0xffffffff;
}

export function getMockCampaignStats(campaign: AdCampaign): MockCampaignStats {
  if (campaign.status === 'paused') return { impressions: 0, clicks: 0, ctr: 0, spend: 0, roas: 0 };

  const daysRunning = Math.max(1, Math.min(30, Math.floor((Date.now() - new Date(campaign.createdAt).getTime()) / 86400000) + 1));
  const dailyBudget = campaign.monthlyBudget / 30;
  const spend = Math.round(dailyBudget * daysRunning * 100) / 100;

  // Platform-flavored CPM/CTR bands, seeded per campaign for variety without
  // being random-every-render.
  const rand = seededFraction(campaign.id);
  const cpm = campaign.platform === 'google' ? 18 + rand * 14 : 12 + rand * 10; // ILS per 1000 impressions
  const impressions = Math.round((spend / cpm) * 1000);
  const ctr = Math.round((1.2 + rand * 2.3) * 100) / 100; // %
  const clicks = Math.round(impressions * (ctr / 100));
  const roas = Math.round((1.8 + rand * 3.2) * 100) / 100;

  return { impressions, clicks, ctr, spend, roas };
}

/** Baseline (platform-funded) campaign exposure — every store gets this automatically, seeded by storeId so it stays stable and roughly scales with how long the store has existed isn't modeled (no per-store creation date threaded through here); a flat plausible daily range is enough for a "you're already getting exposure" indicator. */
export function getMockBaselineImpressions(storeId: string): number {
  const rand = seededFraction(storeId);
  return Math.round(400 + rand * 2200);
}
