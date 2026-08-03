import crypto from 'node:crypto';
import { firstRow, isUuid, query, rows } from './db.js';
import { safeRedirectPath } from './safe-redirect.js';
import { toAgorot } from './money.js';
import { sanitizeImageUrl as sanitizeImageUrlShared } from './image-url.js';

/**
 * Platform BRAND campaigns (CURRENT_TASK.md → סשן ב׳). Distinct from the two product-based ad
 * tiers (baseline feed + seller boosts, see ad-campaigns.ts): these advertise the PLATFORM ITSELF
 * — "open a store on Dezabin" / "shop across many stores" — so unlike a product ad they need
 * creative the owner uploads (headline, body, image, destination), because there is no product
 * feed to render. Owner-managed only, from the admin advertising tab.
 *
 * **Moved to Postgres in the same diff as `ad-campaigns` (DB_MIGRATION_PLAN.md §8), and that is
 * deliberate.** The two feed money through separate modules, and memory
 * `project_brand_boost_twin_drift` records what happens when one is fixed without the other: the
 * pause-stamp rule below exists in both files because it was fixed twice. Everything true of the
 * budget there is true here — integer agorot, named `monthlyBudgetAgorot` so the unit cannot
 * change under a stable name, and read through `bigIntOf` because `pg` hands back a `bigint` as a
 * string that `+` would concatenate.
 *
 * Like every other ad surface here, NOT wired to a real Google/Meta API yet (no keys/business
 * accounts) — `ad-metrics.ts#brandStatsInRange` fabricates stable numbers from the budget.
 */

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
  /** Integer agorot — see the module note. */
  monthlyBudgetAgorot: number;
  durationDays?: BrandDuration; // omitted = ongoing
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
  /** When it was paused — the moment its metrics freeze at (ad-metrics.ts#runPeriod). Carried
   *  here for the same reason AdCampaign carries it: without it, runPeriod falls back to
   *  `updatedAt`, and `updatedAt` moves on every edit. A paused campaign whose budget was then
   *  corrected would have its run period stretched to the day of that correction and report
   *  spend for weeks it never ran. */
  pausedAt?: string;
}

export const BRAND_DURATION_OPTIONS: readonly BrandDuration[] = [7, 14, 30];
const HEADLINE_MAX = 120;
const BODY_MAX = 400;

/** Ceiling on a brand budget, in ILS. `Number.isFinite` alone lets `1e30` through, and the column
 *  is `bigint`: `toAgorot(1e30)` is out of range for it, so an absurd hand-built POST would be a
 *  500 rather than a rejected request. The boost twin gets its cap from `ad-budget.ts`; this one
 *  is the platform's own spend and has no seller-facing form to share a ladder with. */
export const MAX_BRAND_BUDGET = 1_000_000;

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

/** An owner-typed budget in ILS → integer agorot, or null if it is not a budget. The one place a
 *  brand budget crosses from what a person typed into what the column stores. */
export function parseBrandBudgetAgorot(v: unknown): number | null {
  const ils = Number(v);
  if (!Number.isFinite(ils) || ils < 0 || ils > MAX_BRAND_BUDGET) return null;
  return toAgorot(ils);
}

/** Only an in-site path or an http(s) URL is allowed — blocks javascript:/data: and other
 *  unsafe schemes in a click destination. Falls back to the objective's default when
 *  empty/invalid.
 *
 *  The path branch goes through `safeRedirectPath` rather than a bare `startsWith('/')`:
 *  that check passes `//evil.com`, which a browser reads as a HOST, so a "relative path"
 *  destination could quietly point off-site (2026-07-29 — same class as the /api/lang
 *  open redirect; see lib/safe-redirect.ts). Absolute destinations are still allowed here,
 *  deliberately — an ad may legitimately land on an external page. */
export function sanitizeDestination(v: unknown, objective: BrandObjective): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return defaultDestination(objective);
  if (s.startsWith('/')) return safeRedirectPath(s, defaultDestination(objective));
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch { /* not a URL */ }
  return defaultDestination(objective);
}

/** Accept only an https image URL (Cloudinary uploads are https); anything else → undefined. */
/** Was a prefix check (`startsWith('https://')`), which `https://x" onerror=…`
 *  passes — it now shares the real validator in image-url.ts. Kept as a named
 *  export here because the campaign type wants `undefined`, not `null`. */
export function sanitizeImageUrl(v: unknown): string | undefined {
  return sanitizeImageUrlShared(v) ?? undefined;
}

export interface CreateBrandInput {
  objective: BrandObjective;
  headline: string;
  body: string;
  imageUrl?: string;
  destinationUrl: string;
  platform: BrandPlatform;
  monthlyBudgetAgorot: number;
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
  const monthlyBudgetAgorot = parseBrandBudgetAgorot(b.monthlyBudget);
  if (!headline || !bodyText || monthlyBudgetAgorot === null) return null;
  return {
    objective,
    headline,
    body: bodyText,
    imageUrl: sanitizeImageUrl(b.imageUrl),
    destinationUrl: sanitizeDestination(b.destinationUrl, objective),
    platform: parsePlatform(b.platform),
    monthlyBudgetAgorot,
    durationDays: parseBrandDuration(b.durationDays),
  };
}

interface BrandRow {
  id: string;
  objective: string;
  headline: string;
  body: string;
  image_url: string | null;
  destination_url: string;
  platform: string;
  monthly_budget_agorot: string | number;
  duration_days: number | null;
  status: string;
  paused_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `id, objective, headline, body, image_url, destination_url, platform,
  monthly_budget_agorot, duration_days, status, paused_at, created_at, updated_at`;

function isoOf(v: Date | string | null): string | undefined {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toBrandCampaign(row: BrandRow): BrandCampaign {
  const n = row.monthly_budget_agorot;
  const campaign: BrandCampaign = {
    id: row.id,
    objective: row.objective as BrandObjective,
    headline: row.headline,
    body: row.body,
    destinationUrl: row.destination_url,
    platform: row.platform as BrandPlatform,
    // `bigint` is a string from `pg`, a number from PGlite. `admin-ads.ts` SUMS these.
    monthlyBudgetAgorot: Number.isFinite(Number(n)) ? Number(n) : 0,
    status: row.status as BrandCampaign['status'],
    createdAt: isoOf(row.created_at) ?? '',
    updatedAt: isoOf(row.updated_at) ?? '',
  };
  if (row.image_url) campaign.imageUrl = row.image_url;
  if (row.duration_days) campaign.durationDays = row.duration_days as BrandDuration;
  const pausedAt = isoOf(row.paused_at);
  if (pausedAt) campaign.pausedAt = pausedAt;
  return campaign;
}

/** Newest first — `created_at DESC, id`, never `created_at` alone: two campaigns created in the
 *  same second would otherwise swap places between loads (§7.13). Kept unscoped because the admin
 *  brand endpoint LISTS them: this is the screen that shows every brand campaign, one row each,
 *  and it is the owner's own handful of adverts, not a per-seller table. */
export async function getAllBrandCampaigns(): Promise<BrandCampaign[]> {
  const found = await rows<BrandRow>(
    `SELECT ${COLUMNS} FROM brand_campaigns ORDER BY created_at DESC, id`,
  );
  return found.map(toBrandCampaign);
}

/**
 * The brand twin of `ad-campaigns.ts#getCampaignsInRange`, written in the same diff and for the
 * reason memory `project_brand_boost_twin_drift` records: the two campaign kinds feed money in
 * separate modules, and fixing one without the other IS the drift.
 *
 * Same contract — a SUPERSET narrowing, with `ad-metrics.ts#overlapDays` left as the single
 * authority on how many days a campaign ran inside the window. Brand campaigns have no
 * `archived_at`: cancelling one deletes it, which is why there is no archived clause here.
 */
export async function getBrandCampaignsInRange(fromISO: string, toISO: string): Promise<BrandCampaign[]> {
  const found = await rows<BrandRow>(
    `SELECT ${COLUMNS} FROM brand_campaigns
      WHERE (created_at AT TIME ZONE 'UTC')::date <= $2::date
        AND (status = 'active'
             OR (created_at AT TIME ZONE 'UTC')::date >= $1::date
             OR (COALESCE(paused_at, updated_at) AT TIME ZONE 'UTC')::date >= $1::date)
        AND (duration_days IS NULL
             OR (created_at AT TIME ZONE 'UTC')::date >= $1::date
             OR (created_at AT TIME ZONE 'UTC')::date + (duration_days - 1) >= $1::date)
      ORDER BY created_at DESC, id`,
    [fromISO, toISO],
  );
  return found.map(toBrandCampaign);
}

/** How many brand campaigns exist and how many are running, with the active ones' committed
 *  budget — the same three not-range-scoped numbers `getCampaignTotals` answers for boosts. */
export async function getBrandCampaignTotals(): Promise<{ total: number; active: number; activeBudgetAgorot: number }> {
  const row = await firstRow<{ total: string | number; active: string | number; budget: string | number }>(
    `SELECT COUNT(*)                                              AS total,
            COUNT(*) FILTER (WHERE status = 'active')             AS active,
            COALESCE(SUM(monthly_budget_agorot) FILTER (WHERE status = 'active'), 0) AS budget
       FROM brand_campaigns`,
  );
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    activeBudgetAgorot: Number(row?.budget ?? 0),
  };
}

export async function createBrandCampaign(input: CreateBrandInput): Promise<BrandCampaign> {
  const { rows: written } = await query<BrandRow>(
    `INSERT INTO brand_campaigns (
       id, objective, headline, body, image_url, destination_url, platform,
       monthly_budget_agorot, duration_days, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
     RETURNING ${COLUMNS}`,
    [
      crypto.randomUUID(), input.objective, input.headline, input.body,
      input.imageUrl ?? null, input.destinationUrl, input.platform,
      input.monthlyBudgetAgorot, input.durationDays ?? null,
    ],
  );
  return toBrandCampaign(written[0]!);
}

/**
 * Change a brand campaign's budget or status.
 *
 * The same stamp/clear the boost twin does (ad-campaigns.ts#updateCampaign), in the same shape and
 * for the same reason: on a real status transition only, so a plain budget edit never moves the
 * moment the metrics froze at. The `CASE` reads the OLD `status` — that is what an `UPDATE … SET`
 * sees on the right-hand side — which is what makes the transition test a single statement rather
 * than a read-then-write two processes could interleave.
 */
export async function updateBrandCampaign(
  id: string,
  updates: { monthlyBudgetAgorot?: number; status?: 'active' | 'paused' },
): Promise<BrandCampaign | undefined> {
  if (!isUuid(id)) return undefined;
  const budget = updates.monthlyBudgetAgorot;
  const status = updates.status === 'active' || updates.status === 'paused' ? updates.status : null;
  const found = await rows<BrandRow>(
    `UPDATE brand_campaigns SET
       monthly_budget_agorot = COALESCE($2::bigint, monthly_budget_agorot),
       status                = COALESCE($3::text, status),
       paused_at = CASE
         WHEN $3::text = 'active' THEN NULL
         WHEN $3::text = 'paused' AND status <> 'paused' THEN now()
         ELSE paused_at END,
       updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      budget !== undefined && Number.isFinite(budget) && budget >= 0 ? Math.round(budget) : null,
      status,
    ],
  );
  return found[0] ? toBrandCampaign(found[0]) : undefined;
}

/**
 * Delete a brand campaign outright — and unlike the seller boost beside it, that is correct here.
 * A boost row is a bill the platform sends a seller, so cancelling it archives rather than
 * deletes; a brand campaign is the platform advertising ITSELF, an expense it owns, with nobody to
 * report a figure to. `platform-revenue.ts` deliberately excludes these rows for the same reason.
 */
export async function deleteBrandCampaign(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('DELETE FROM brand_campaigns WHERE id = $1', [id]);
  return rowCount > 0;
}
