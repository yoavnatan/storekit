/** Turns an untrusted "launch a boost" request body into a CreateCampaignInput — the single
 *  validation path for BOTH /api/seller/ad-campaigns and its admin twin /api/admin/ad-campaigns.
 *
 *  It lived as two verbatim copies before a campaign could cover more than one product; a rule
 *  duplicated across modules is the bug waiting to happen, and this one decides which store's
 *  products a seller may spend money advertising, so the copies were the wrong place for it.
 *
 *  Ownership is re-checked here against the store, never trusted from the request: a hand-built
 *  POST could otherwise name another seller's product or category and pull it into this store's
 *  campaign (and confirm, by the error it got back, that the id exists).
 */
import { getProductsByStoreId, isProductVisible } from './store-products.js';
import { getCategoriesByStoreId } from './store-categories.js';
import { parseAudience, parseDuration, type CreateCampaignInput } from './ad-campaigns.js';
import { toAgorot } from './money.js';
import { MIN_CAMPAIGN_BUDGET, MAX_CAMPAIGN_BUDGET, isValidCampaignBudget } from './ad-budget.js';

/** A boost naming hundreds of products is a store-wide campaign wearing a costume, and the card
 *  can only name a couple before it stops informing anyone. Enforced server-side so a
 *  hand-built POST can't exceed it either. Categories match the sale scope's own cap. */
export const MAX_CAMPAIGN_PRODUCTS = 50;
export const MAX_CAMPAIGN_CATEGORIES = 8;

// The budget rules live in the pure `ad-budget.ts` so the browser can share them (the create
// form's min/max, the campaign card's inline editor); re-exported here because both API routes
// already import their validation from this module.
export { MIN_CAMPAIGN_BUDGET, MAX_CAMPAIGN_BUDGET, AD_BUDGET_PRESETS, isValidCampaignBudget } from './ad-budget.js';

/** Only the two store fields this module needs — the seller route resolves its store from the
 *  session, the admin route by slug, and neither should have to hand over the whole record. */
interface StoreRef { id: string; slug: string; demo?: boolean }

export type CampaignInputResult =
  | { ok: true; input: CreateCampaignInput }
  | { ok: false; error: string; status: number };

/** Accepts both shapes the two forms post: an array of ids (the multi picker) and the single
 *  `productId` string the admin's per-store form has always sent. Trimmed, de-duplicated,
 *  order-preserving — the seller's pick order is what the card names.
 *
 *  `cap` is the caller's own limit, and collecting stops one past it: the caller's `> cap` check
 *  still fires with the same error, but an oversized POST never gets to drive the whole pass.
 *  De-duplication is Set-based rather than `out.includes` for the same reason — that was linear
 *  in a list the request controls, so the pass was quadratic (measured before this: 40k ids
 *  blocked the single SSR thread for ~5s, and it grew 4× per doubling). */
function idList(cap: number, ...values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    for (const item of raw) {
      if (out.length > cap) return out;
      if (typeof item !== 'string') continue;
      const id = item.trim();
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

interface CampaignBody {
  scope?: unknown;
  productId?: unknown;
  productIds?: unknown;
  categoryIds?: unknown;
  platform?: unknown;
  monthlyBudget?: unknown;
  durationDays?: unknown;
  audience?: unknown;
}

/** Just the fields that say WHAT a campaign advertises. */
type ScopeFields = Pick<CreateCampaignInput,
  'scope' | 'productId' | 'productName' | 'productIds' | 'productNames' | 'categoryIds' | 'categoryNames'>;

type ScopeResult = { ok: true; scope: ScopeFields } | { ok: false; error: string; status: number };

/** Which products/categories this campaign advertises, resolved against what the store actually
 *  owns. Ids the store doesn't own are dropped rather than echoed back; losing ALL of them is
 *  the error, since a campaign that silently widened to the whole store would spend the seller's
 *  budget on something he never asked for. */
async function resolveScope(body: CampaignBody, store: StoreRef): Promise<ScopeResult> {
  const scope = body.scope;

  if (scope === 'product' || scope === 'products') {
    const wanted = idList(MAX_CAMPAIGN_PRODUCTS, body.productIds, body.productId);
    if (!wanted.length) return { ok: false, error: 'Missing productId', status: 400 };
    if (wanted.length > MAX_CAMPAIGN_PRODUCTS) return { ok: false, error: `Up to ${MAX_CAMPAIGN_PRODUCTS} products per campaign`, status: 400 };
    // What the picker shows is what the server accepts: on the storefront (not seller-hidden or
    // admin-blocked) AND in stock. A stale page or a hand-built POST would otherwise start a
    // campaign pointing at a 404 or at a "sold out" page, and pay for every click to it.
    // Starting a campaign on something nobody can buy is a different decision from continuing
    // one through a stock-out — which is why ad-campaign-health.ts only PAUSES for that.
    const owned = (await getProductsByStoreId(store.id)).filter((p) => isProductVisible(p) && p.stock > 0);
    // Mapped over `wanted`, not filtered over the catalog: the seller's pick order is what the
    // card names, and the catalog's own order would read as a different campaign.
    const picked = wanted.map((id) => owned.find((p) => p.id === id)).filter((p) => !!p);
    // A code, not a sentence: the client owns the wording, in the seller's own language. 409
    // rather than 404 — the ids may well exist, they just cannot be advertised right now.
    if (!picked.length) return { ok: false, error: 'PRODUCT_NOT_ADVERTISABLE', status: 409 };
    // Exactly one product collapses back to the flat, long-standing single-product shape, so
    // every pre-existing reader of `scope: 'product'` + `productId` keeps working untouched.
    if (picked.length === 1) {
      return { ok: true, scope: { scope: 'product', productId: picked[0]!.id, productName: picked[0]!.name } };
    }
    return { ok: true, scope: { scope: 'products', productIds: picked.map((p) => p.id), productNames: picked.map((p) => p.name) } };
  }

  if (scope === 'categories') {
    const wanted = idList(MAX_CAMPAIGN_CATEGORIES, body.categoryIds);
    if (!wanted.length) return { ok: false, error: 'Missing categoryIds', status: 400 };
    if (wanted.length > MAX_CAMPAIGN_CATEGORIES) return { ok: false, error: `Up to ${MAX_CAMPAIGN_CATEGORIES} categories per campaign`, status: 400 };
    const owned = await getCategoriesByStoreId(store.id);
    const picked = wanted.map((id) => owned.find((c) => c.id === id)).filter((c) => !!c);
    if (!picked.length) return { ok: false, error: 'Category not found', status: 404 };
    return { ok: true, scope: { scope: 'categories', categoryIds: picked.map((c) => c.id), categoryNames: picked.map((c) => c.name) } };
  }

  if (scope === 'store') return { ok: true, scope: { scope: 'store' } };
  return { ok: false, error: 'Invalid scope', status: 400 };
}

export async function buildCampaignInput(body: CampaignBody, store: StoreRef): Promise<CampaignInputResult> {
  const { platform, monthlyBudget } = body;
  // **A showcase store may not be advertised, at all (owner, 2026-08-06 — emphatically).** Its
  // catalogue is fabricated, and submitting fabricated products to Merchant Center is a policy
  // violation against the ONE account every seller on the platform is advertised through
  // (api/feed/products.xml.ts) — the blast radius is every store at once, not this one.
  //
  // The feed has always excluded them. The gap was on this side: nothing stopped a campaign being
  // CREATED on one, and `ad-campaign-health.ts` (which asked only `canStoreSell`, a demo store
  // passes) then reported it as perfectly healthy while it advertised nothing. Refused here rather
  // than only pausing later, because a campaign that cannot legitimately exist should not exist:
  // the health sweep is the floor under a store that BECOMES a showcase, not the gate.
  //
  // In `buildCampaignInput` and not in either route, because the admin route reaches ANY store by
  // slug — which is exactly how a showcase store's campaign would be created.
  if (store.demo) return { ok: false, error: 'CAMPAIGN_DEMO_STORE', status: 400 };
  if (platform !== 'google' && platform !== 'meta' && platform !== 'both') return { ok: false, error: 'Invalid platform', status: 400 };
  if (!isValidCampaignBudget(monthlyBudget)) {
    return {
      ok: false,
      status: 400,
      error: typeof monthlyBudget === 'number' && monthlyBudget > MAX_CAMPAIGN_BUDGET
        ? `Maximum budget is ${MAX_CAMPAIGN_BUDGET} ₪`
        : `Minimum monthly budget is ${MIN_CAMPAIGN_BUDGET} ₪`,
    };
  }

  const scoped = await resolveScope(body, store);
  if (!scoped.ok) return scoped;

  const durationDays = parseDuration(body.durationDays);
  // A store-wide campaign self-targets per product (each product's own feed attributes), so it
  // never carries a single audience even if one is posted. Any narrowed scope may: the seller
  // chose that slice himself, and all/all still means "no restriction" (parseAudience drops it).
  const audience = scoped.scope.scope === 'store' ? undefined : parseAudience(body.audience);

  return {
    ok: true,
    input: {
      storeId: store.id,
      storeSlug: store.slug,
      platform,
      // The seller types shekels and the column stores integer agorot — this is the ONE place a
      // boost budget crosses the boundary on the way in (ad-campaigns.ts module note). Safe to
      // convert only because `isValidCampaignBudget` above already bounded it: `toAgorot` of an
      // unbounded number overflows the `bigint` column into a 500 instead of a 400.
      monthlyBudgetAgorot: toAgorot(monthlyBudget),
      ...scoped.scope,
      ...(durationDays ? { durationDays } : {}),
      ...(audience ? { audience } : {}),
    },
  };
}
