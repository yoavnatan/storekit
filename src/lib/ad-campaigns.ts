import crypto from 'node:crypto';
import { isUuid, query, rows } from './db.js';
import type { AdScopeKind } from './ad-scope-label.js';

/**
 * Seller-funded "boost" campaigns — the paid tier of the two-tier ads model
 * (AI_INSTRUCTIONS.md "Ads — two-tier model"). Every product is already in the platform-funded
 * baseline campaign automatically and has no row here; a row here is a boost the seller bought.
 *
 * **Moved to Postgres (DB_MIGRATION_PLAN.md §8, "the rest").** Three things changed with the move
 * and each one is a rule, not a detail:
 *
 * · **The budget is integer agorot and its NAME says so (§7.7).** It was `monthlyBudget`, a
 *   floating ILS number. Changing the unit under the same name is a hundred-fold error the
 *   compiler passes in silence, so the field is `monthlyBudgetAgorot` and every one of its readers
 *   had to be visited. The seller still types shekels — `ad-campaign-input.ts` converts once, on
 *   the way in, and `ad-metrics.ts` converts once, on the way out.
 * · **The column is `bigint`, which `pg` returns as a STRING.** `'50000' + '50000'` is
 *   `'5000050000'`, not a sum, and `admin-ads.ts` adds budgets across a store's campaigns. Every
 *   read goes through `bigIntOf`.
 * · **Empty is not missing.** `product_ids`/`category_ids` are `NOT NULL DEFAULT '{}'`, so a
 *   single-product campaign reads back `[]` where the file held `undefined`. They are mapped back
 *   to `undefined` so the row shape every existing reader was written against is unchanged.
 *
 * A real Google Ads/Meta Marketing API integration is still not wired up (no keys/business
 * accounts), so `ad-metrics.ts` fabricates stable performance numbers from the budget and no real
 * charge happens yet.
 */
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
  /** The seller's cap, in integer agorot. Never a fractional shekel — see the module note. */
  monthlyBudgetAgorot: number;
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

export type CreateCampaignInput = Pick<AdCampaign, 'storeId' | 'storeSlug' | 'scope' | 'platform' | 'monthlyBudgetAgorot'> &
  Partial<Pick<AdCampaign,
    'productId' | 'productName' | 'productIds' | 'productNames' |
    'categoryIds' | 'categoryNames' | 'durationDays' | 'audience'>>;

/** What `updateCampaign` may change. Budget and status are the seller's; `pausedReason` is the
 *  platform's own sweep (ad-campaign-health.ts) and is never set from a request body. */
export interface CampaignUpdate {
  monthlyBudgetAgorot?: number;
  status?: 'active' | 'paused';
  pausedReason?: 'unavailable' | 'out-of-stock';
}

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

interface CampaignRow {
  id: string;
  store_id: string;
  store_slug: string;
  scope: string;
  product_id: string | null;
  product_name: string | null;
  product_ids: string[];
  product_names: string[];
  category_ids: string[];
  category_names: string[];
  platform: string;
  monthly_budget_agorot: string | number;
  duration_days: number | null;
  audience_gender: string | null;
  audience_age: string | null;
  status: string;
  paused_at: Date | string | null;
  paused_reason: string | null;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = `id, store_id, store_slug, scope, product_id, product_name, product_ids,
  product_names, category_ids, category_names, platform, monthly_budget_agorot, duration_days,
  audience_gender, audience_age, status, paused_at, paused_reason, archived_at, created_at, updated_at`;

/** `bigint` is a STRING from `pg` and a number from PGlite — see the module note on `+=`. */
function bigIntOf(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function isoOf(v: Date | string | null): string | undefined {
  if (!v) return undefined;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toCampaign(row: CampaignRow): AdCampaign {
  const campaign: AdCampaign = {
    id: row.id,
    storeId: row.store_id,
    storeSlug: row.store_slug,
    scope: row.scope as AdScopeKind,
    platform: row.platform as AdCampaign['platform'],
    monthlyBudgetAgorot: bigIntOf(row.monthly_budget_agorot),
    status: row.status as AdCampaign['status'],
    createdAt: isoOf(row.created_at) ?? '',
    updatedAt: isoOf(row.updated_at) ?? '',
  };
  if (row.product_id) campaign.productId = row.product_id;
  if (row.product_name) campaign.productName = row.product_name;
  // `[]` is what the column holds for a scope that names nothing — the file held `undefined`, and
  // every reader was written against that shape.
  if (row.product_ids.length) campaign.productIds = row.product_ids;
  if (row.product_names.length) campaign.productNames = row.product_names;
  if (row.category_ids.length) campaign.categoryIds = row.category_ids;
  if (row.category_names.length) campaign.categoryNames = row.category_names;
  if (row.duration_days) campaign.durationDays = row.duration_days as 7 | 14 | 30;
  if (row.audience_gender || row.audience_age) {
    campaign.audience = {
      gender: (row.audience_gender ?? 'all') as AdGender,
      age: (row.audience_age ?? 'all') as AdAgeRange,
    };
  }
  const pausedAt = isoOf(row.paused_at);
  if (pausedAt) campaign.pausedAt = pausedAt;
  if (row.paused_reason) campaign.pausedReason = row.paused_reason as AdCampaign['pausedReason'];
  const archivedAt = isoOf(row.archived_at);
  if (archivedAt) campaign.archivedAt = archivedAt;
  return campaign;
}

/** Every campaign across all stores — for the admin's platform-wide advertising overview.
 *  Unbounded like `getAllStores`/`getAllOrders` beside it (§3), and moves when they do. */
export async function getAllCampaigns(): Promise<AdCampaign[]> {
  const found = await rows<CampaignRow>(
    `SELECT ${COLUMNS} FROM ad_campaigns ORDER BY created_at DESC, id`,
  );
  return found.map(toCampaign);
}

/** A store's LIVE campaigns — cancelled ones are history and come from getArchivedByStoreId. */
export async function getCampaignsByStoreId(storeId: string): Promise<AdCampaign[]> {
  return byStore(storeId, 'archived_at IS NULL');
}

/** The cancelled ones, newest first. Read-only everywhere: nothing may be resumed or re-budgeted
 *  out of here, it exists to answer "what did I run, and what did it cost". */
export async function getArchivedByStoreId(storeId: string): Promise<AdCampaign[]> {
  return byStore(storeId, 'archived_at IS NOT NULL');
}

async function byStore(storeId: string, archiveClause: string): Promise<AdCampaign[]> {
  if (!isUuid(storeId)) return [];
  // `created_at DESC, id` — never `created_at` alone. Two campaigns launched in the same second
  // would otherwise come back in a different order on every load (§7.13).
  const found = await rows<CampaignRow>(
    `SELECT ${COLUMNS} FROM ad_campaigns
      WHERE store_id = $1 AND ${archiveClause}
      ORDER BY created_at DESC, id`,
    [storeId],
  );
  return found.map(toCampaign);
}

export async function createCampaign(input: CreateCampaignInput): Promise<AdCampaign> {
  const { rows: written } = await query<CampaignRow>(
    `INSERT INTO ad_campaigns (
       id, store_id, store_slug, scope, product_id, product_name, product_ids, product_names,
       category_ids, category_names, platform, monthly_budget_agorot, duration_days,
       audience_gender, audience_age, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'active')
     RETURNING ${COLUMNS}`,
    [
      crypto.randomUUID(), input.storeId, input.storeSlug, input.scope,
      input.productId ?? null, input.productName ?? null,
      input.productIds ?? [], input.productNames ?? [],
      input.categoryIds ?? [], input.categoryNames ?? [],
      input.platform, input.monthlyBudgetAgorot, input.durationDays ?? null,
      input.audience?.gender ?? null, input.audience?.age ?? null,
    ],
  );
  return toCampaign(written[0]!);
}

/**
 * Change a campaign's budget, status or pause reason — one statement, and the pause bookkeeping
 * happens inside it.
 *
 * **`WHERE archived_at IS NULL` is the history guard, and it belongs in the statement.** The file
 * version read the row, checked `archivedAt` in JS and then wrote: two campaigns cancelled at once,
 * or a cancel racing a budget edit, could re-open a row that had already left the live list and
 * rewrite a figure that was already reported. A predicate the database evaluates cannot be raced.
 *
 * The `CASE` arms read the OLD row (that is what an `UPDATE … SET` sees on the right-hand side),
 * which is what makes "stamp the pause moment only on a real active → paused transition" a single
 * statement rather than a read-then-write. A plain budget edit must not disturb `paused_at`: it is
 * what freezes the accrued metrics (ad-metrics.ts#runPeriod), and moving it would stretch a paused
 * campaign's run period to the day of the correction and report spend for weeks it never ran.
 */
export async function updateCampaign(
  id: string,
  storeId: string,
  updates: CampaignUpdate,
): Promise<AdCampaign | undefined> {
  return (await applyUpdate(storeId, [id], updates))[0];
}

/** The batch form. `ad-campaign-health.ts` sweeps a whole store at once, and one statement per
 *  campaign there is the query-in-a-loop shape a file read used to hide. */
export async function updateCampaigns(
  storeId: string,
  ids: readonly string[],
  updates: CampaignUpdate,
): Promise<AdCampaign[]> {
  return applyUpdate(storeId, ids, updates);
}

async function applyUpdate(
  storeId: string,
  ids: readonly string[],
  updates: CampaignUpdate,
): Promise<AdCampaign[]> {
  const valid = ids.filter(isUuid);
  if (!valid.length || !isUuid(storeId)) return [];
  const budget = updates.monthlyBudgetAgorot;
  const found = await rows<CampaignRow>(
    `UPDATE ad_campaigns SET
       monthly_budget_agorot = COALESCE($4::bigint, monthly_budget_agorot),
       status                = COALESCE($5::text, status),
       paused_at = CASE
         WHEN $5::text = 'active' THEN NULL
         WHEN $5::text = 'paused' AND status <> 'paused' THEN now()
         ELSE paused_at END,
       paused_reason = CASE
         WHEN $5::text = 'active' THEN NULL
         WHEN $6::boolean THEN $7::text
         ELSE paused_reason END,
       updated_at = now()
     WHERE store_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL AND $3::boolean
     RETURNING ${COLUMNS}`,
    [
      storeId, valid,
      // Nothing to change is not an empty UPDATE — it is a no-op that must still not touch
      // `updated_at`, so the whole statement is predicated off instead.
      budget !== undefined || updates.status !== undefined || updates.pausedReason !== undefined,
      // Ignored rather than written when it is not a budget — the same rule the brand twin applies
      // (`updateBrandCampaign`), and the twins have to agree: `project_brand_boost_twin_drift` is
      // the record of what a fix to one of them alone costs. A negative reaching the statement is
      // a CHECK violation, i.e. a 500 on the dashboard rather than a rejected field.
      budget !== undefined && Number.isFinite(budget) && budget >= 0 ? Math.round(budget) : null,
      updates.status ?? null,
      updates.pausedReason !== undefined,
      updates.pausedReason ?? null,
    ],
  );
  return found.map(toCampaign);
}

/** Archiving also PAUSES and stamps `paused_at`, because that date is what bounds the run period —
 *  without it the cancelled campaign's metrics would go on accruing forever. `COALESCE` keeps an
 *  earlier pause moment: it was already frozen there. */
const ARCHIVE_SQL = `UPDATE ad_campaigns
     SET status = 'paused', paused_at = COALESCE(paused_at, now()), archived_at = now(), updated_at = now()
   WHERE store_id = $1 AND archived_at IS NULL`;

/**
 * Cancel a campaign: it stops, and it stays. There is deliberately NO function here that removes a
 * campaign row — the spend it accrued is part of a month's reported figures, and a delete would
 * rewrite them after the fact. Stopping it is a status change; forgetting it is not something a
 * dashboard button may do.
 *
 * Idempotent, and the second click costs a second statement rather than risking a first one: the
 * `WHERE archived_at IS NULL` means a replay affects no row, and only then is the existing row read
 * back so the caller still gets it. Doing it the other way — archiving unconditionally — would move
 * `archived_at` forward on every click and un-freeze the metrics that date bounds.
 */
export async function archiveCampaign(id: string, storeId: string): Promise<AdCampaign | undefined> {
  if (!isUuid(id) || !isUuid(storeId)) return undefined;
  const { rows: archived } = await query<CampaignRow>(
    `${ARCHIVE_SQL} AND id = $2 RETURNING ${COLUMNS}`,
    [storeId, id],
  );
  if (archived[0]) return toCampaign(archived[0]);
  const existing = await rows<CampaignRow>(
    `SELECT ${COLUMNS} FROM ad_campaigns WHERE id = $1 AND store_id = $2`,
    [id, storeId],
  );
  return existing[0] ? toCampaign(existing[0]) : undefined;
}

/**
 * Cancel a NAMED set of a store's campaigns in one statement — what the health sweep does with the
 * fixed-duration campaigns that reached their last day (ad-campaign-health.ts). It archives an
 * arbitrary subset, so unlike the whole-store form below it still needs the id list.
 *
 * Returns how many were still live, which is the number that actually stopped. The rows are not
 * read back: the sweep drops them from the live list either way, and a campaign already archived
 * (a second tab got there first) is the same outcome, not an error.
 */
export async function archiveCampaigns(storeId: string, ids: readonly string[]): Promise<number> {
  const valid = ids.filter(isUuid);
  if (!valid.length || !isUuid(storeId)) return 0;
  const { rowCount } = await query(`${ARCHIVE_SQL} AND id = ANY($2::uuid[])`, [storeId, valid]);
  return rowCount;
}

/**
 * Cancel every live campaign a store still has — what closing a store does on its way out
 * (store-lifecycle.ts). One statement rather than one per campaign: closure always archives ALL of
 * them, so the loop was N writes every time, not N writes in the rare case.
 *
 * Returns how many were still live, which is the number that actually stopped.
 */
export async function archiveCampaignsForStore(storeId: string): Promise<number> {
  if (!isUuid(storeId)) return 0;
  const { rowCount } = await query(ARCHIVE_SQL, [storeId]);
  return rowCount;
}
