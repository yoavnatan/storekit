import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CAMPAIGNS_PATH = path.join(process.cwd(), 'data/brand-campaigns.json');

// Platform BRAND campaigns (CURRENT_TASK.md → סשן ב׳). Distinct from the two
// product-based ad tiers (baseline feed + seller boosts, see ad-campaigns.ts):
// these advertise the PLATFORM ITSELF — "open a store on Dezabin" / "shop
// across many stores" — so unlike a product ad they need creative the owner
// uploads (headline, body, image, destination), because there's no product feed
// to render. Owner-managed only, from the admin advertising tab.
//
// Like every other ad surface here, NOT wired to a real Google/Meta API yet
// (no keys/business accounts) — `getMockBrandStats()` fabricates stable numbers
// from the budget. Nothing here moves money, so it skips the money/stock mutex
// + Vitest rule that applies to real payment code.

export type BrandObjective = 'buyers' | 'sellers';
export type BrandPlatform = 'google' | 'meta';
export type BrandDuration = 7 | 14 | 30;

export interface BrandCampaign {
  id: string;
  /** Who the campaign is trying to attract — sets the default click destination. */
  objective: BrandObjective;
  headline: string;
  body: string;
  imageUrl?: string;      // Cloudinary secure_url
  destinationUrl: string; // where a click lands (relative path or absolute https URL)
  platform: BrandPlatform;
  monthlyBudget: number;  // ILS
  durationDays?: BrandDuration; // omitted = ongoing
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
}

export const BRAND_DURATION_OPTIONS: readonly BrandDuration[] = [7, 14, 30];
const HEADLINE_MAX = 120;
const BODY_MAX = 400;

/** Default click destination per objective. Relative paths — they resolve against
 *  the real domain once one is set (see GO_LIVE_CHECKLIST.md). */
export function defaultDestination(objective: BrandObjective): string {
  return objective === 'sellers' ? '/seller/register' : '/';
}

export function parseObjective(v: unknown): BrandObjective {
  return v === 'sellers' ? 'sellers' : 'buyers';
}

export function parsePlatform(v: unknown): BrandPlatform {
  return v === 'meta' ? 'meta' : 'google';
}

export function parseBrandDuration(v: unknown): BrandDuration | undefined {
  const n = Number(v);
  return BRAND_DURATION_OPTIONS.includes(n as BrandDuration) ? (n as BrandDuration) : undefined;
}

/** Only a relative path (starts with "/") or an http(s) URL is allowed — blocks
 *  javascript:/data: and other unsafe schemes in a click destination. Falls back
 *  to the objective's default when empty/invalid. */
export function sanitizeDestination(v: unknown, objective: BrandObjective): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return defaultDestination(objective);
  if (s.startsWith('/')) return s;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch { /* not a URL */ }
  return defaultDestination(objective);
}

/** Accept only an https image URL (Cloudinary uploads are https); anything else → undefined. */
export function sanitizeImageUrl(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.startsWith('https://') ? s : undefined;
}

export interface CreateBrandInput {
  objective: BrandObjective;
  headline: string;
  body: string;
  imageUrl?: string;
  destinationUrl: string;
  platform: BrandPlatform;
  monthlyBudget: number;
  durationDays?: BrandDuration;
}

/** Coerce an untrusted request body into a valid create input, or null if the
 *  required text/budget are missing — the API returns 400 on null. */
export function parseCreateInput(body: unknown): CreateBrandInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const objective = parseObjective(b.objective);
  const headline = (typeof b.headline === 'string' ? b.headline.trim() : '').slice(0, HEADLINE_MAX);
  const bodyText = (typeof b.body === 'string' ? b.body.trim() : '').slice(0, BODY_MAX);
  const budget = Number(b.monthlyBudget);
  if (!headline || !bodyText || !Number.isFinite(budget) || budget < 0) return null;
  return {
    objective,
    headline,
    body: bodyText,
    imageUrl: sanitizeImageUrl(b.imageUrl),
    destinationUrl: sanitizeDestination(b.destinationUrl, objective),
    platform: parsePlatform(b.platform),
    monthlyBudget: Math.round(budget),
    durationDays: parseBrandDuration(b.durationDays),
  };
}

function readAll(): BrandCampaign[] {
  try { return JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, 'utf8')) as BrandCampaign[]; }
  catch { return []; }
}

function writeAll(campaigns: BrandCampaign[]): void {
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(campaigns, null, 2));
}

export function getAllBrandCampaigns(): BrandCampaign[] {
  return readAll().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function createBrandCampaign(input: CreateBrandInput): BrandCampaign {
  const all = readAll();
  const now = new Date().toISOString();
  const campaign: BrandCampaign = {
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

export function updateBrandCampaign(id: string, updates: Partial<Pick<BrandCampaign, 'monthlyBudget' | 'status'>>): BrandCampaign | undefined {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return undefined;
  const next = { ...all[idx]! };
  if (updates.status === 'active' || updates.status === 'paused') next.status = updates.status;
  if (updates.monthlyBudget !== undefined && Number.isFinite(updates.monthlyBudget) && updates.monthlyBudget >= 0) {
    next.monthlyBudget = Math.round(updates.monthlyBudget);
  }
  next.updatedAt = new Date().toISOString();
  all[idx] = next;
  writeAll(all);
  return next;
}

export function deleteBrandCampaign(id: string): boolean {
  const all = readAll();
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

export interface MockBrandStats {
  impressions: number;
  clicks: number;
  ctr: number;         // %
  spend: number;       // ILS
  conversions: number; // signups / new buyers attributed (awareness → action)
}

// Deterministic per-campaign "random" seeded by id, so numbers stay stable
// across reloads — same stand-in approach as ad-campaigns.ts.
function seededFraction(seed: string): number {
  return crypto.createHash('sha256').update(seed).digest().readUInt32BE(0) / 0xffffffff;
}

export function getMockBrandStats(campaign: BrandCampaign): MockBrandStats {
  if (campaign.status === 'paused') return { impressions: 0, clicks: 0, ctr: 0, spend: 0, conversions: 0 };

  const daysRunning = Math.max(1, Math.min(30, Math.floor((Date.now() - new Date(campaign.createdAt).getTime()) / 86400000) + 1));
  const spend = Math.round((campaign.monthlyBudget / 30) * daysRunning * 100) / 100;

  const rand = seededFraction(campaign.id);
  // Brand/awareness ads run cheaper CPMs than shopping but convert less directly.
  const cpm = campaign.platform === 'google' ? 10 + rand * 8 : 8 + rand * 7;
  const impressions = Math.round((spend / cpm) * 1000);
  const ctr = Math.round((0.7 + rand * 1.6) * 100) / 100; // %
  const clicks = Math.round(impressions * (ctr / 100));
  const conversions = Math.round(clicks * (0.02 + rand * 0.05)); // 2%–7% of clicks act

  return { impressions, clicks, ctr, spend, conversions };
}
