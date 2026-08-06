/** Is a boost still advertising anything a shopper can actually reach?
 *
 *  A campaign names products (or categories, or the whole store) at the moment it is launched,
 *  and then keeps running. What it names can disappear underneath it: the seller takes a product
 *  off the shelf, an admin blocks it, the product is deleted, a whole category is removed. The
 *  campaign row knows nothing about any of that — so without this module a seller keeps paying
 *  Google and Meta to send shoppers to a page that 404s, and the dashboard keeps reporting
 *  impressions for it.
 *
 *  Two halves, deliberately different in severity:
 *    - NOTHING left to advertise → the campaign is paused automatically, with the reason stored.
 *      Pausing (not deleting) is what freezes its accrued metrics where they stand instead of
 *      erasing them, and it is what stops spend the moment real billing is wired.
 *    - SOME of it left → the campaign keeps running on what survives, and the card says how many
 *      are gone. Narrowing a seller's campaign for him is not a call this should make.
 *
 *  Out of stock is the THIRD state, and it is deliberately not treated like either of those. Ads
 *  pointing at a page that says "sold out" burn budget just as surely as ads pointing at a 404 —
 *  so the campaign does stop. But a stock-out is mechanical and temporary, not a decision anyone
 *  made, so it is the one pause that undoes ITSELF the moment stock returns. Demanding a manual
 *  resume there would punish a seller for selling out, which is the opposite of the point.
 *
 *  So: who paused it decides who may un-pause it.
 *    - a human took it off the shelf  → the platform pauses; only a human resumes.
 *    - it merely sold out             → the platform pauses AND resumes, by itself.
 */
import { getProductsByStoreId, isProductVisible, type StoreProduct } from './store-products.js';
import { getStoreById, canStoreSell } from './stores.js';
import { isDemoStore } from './demo-stores.js';
import { getCategoriesByStoreId, resolveCategoryFilterIds, type StoreCategory } from './store-categories.js';
import { getCampaignsByStoreId, getArchivedByStoreId, updateCampaigns, archiveCampaigns, type AdCampaign, type CampaignUpdate } from './ad-campaigns.js';
import { isCampaignEnded } from './ad-metrics.js';
import { adExclusionReason } from './product-feed.js';
import { store as platform } from '../config/store.config.js';
import { stripTrailingSlashes } from './url-base.js';

export interface CampaignHealth {
  /** Products the campaign covers — named ones for a product scope, matched ones otherwise. */
  total: number;
  /** How many of them are still ON the storefront (not blocked, hidden or deleted). */
  live: number;
  /**
   * How many of `live` the ad platforms can actually carry — the feed's own rule
   * (product-feed.ts#isProductAdvertisable), which today means a usable photo and a real price.
   *
   * **Separate from `live` on purpose (2026-08-06).** `image_link` is a required attribute, so a
   * product the seller never photographed sits happily on the shelf and is absent from Merchant
   * Center — and the card was counting it, reporting a campaign as bigger than it was. Folding that
   * into `live` was tried and is wrong: `live === 0` is the STARVED state, which pauses a campaign
   * as 'unavailable' and then waits for a human, and a missing photo is a mechanical, temporary
   * gap of exactly the kind this module refuses to make a person clear by hand. So it informs the
   * seller and pauses nothing. Wiring it to a pause of its own needs a third stored reason, which
   * is a decision about the seller's money and not one to take in passing.
   */
  advertisable: number;
  /**
   * Of `live`, how many the ad networks' own prohibited-content policy blocks (`ad-policy.ts`).
   *
   * A subset of the non-`advertisable` ones, split out because it is a different kind of problem
   * and needs a different answer. A missing photo costs this seller reach; prohibited content
   * suspends the ACCOUNT — and this platform advertises every seller through one, so it costs
   * every store at once. That is also why it is never self-healing: the term does not stop being
   * prohibited, and the seller has to change or remove the listing.
   */
  policyBlocked: number;
  /** How many of those a shopper could actually buy right now — `live` minus the sold-out ones.
   *  Always <= live, and the two differ only while stock is out. */
  buyable: number;
}

/** Every product a campaign advertises, as the storefront sees it. For a named-product campaign
 *  a deleted id simply doesn't come back, which is what makes it count as unavailable. */
function coveredProducts(campaign: AdCampaign, products: StoreProduct[], categories: StoreCategory[]): StoreProduct[] {
  if (campaign.scope === 'product' || campaign.scope === 'products') {
    const ids = campaign.productIds ?? (campaign.productId ? [campaign.productId] : []);
    return products.filter((p) => ids.includes(p.id));
  }
  if (campaign.scope === 'categories') {
    // A picked category covers everything beneath it too — the same rule the storefront's own
    // category filter uses (store-categories.ts#resolveCategoryFilterIds).
    const wanted = new Set((campaign.categoryIds ?? []).flatMap((id) => resolveCategoryFilterIds(categories, id)));
    return products.filter((p) => !!p.categoryId && wanted.has(p.categoryId));
  }
  return products;
}

export function campaignHealth(campaign: AdCampaign, products: StoreProduct[], categories: StoreCategory[]): CampaignHealth {
  const covered = coveredProducts(campaign, products, categories);
  // `total` counts what the campaign was pointed at, so a deleted product still shows up as one
  // that is gone — for a named-product campaign that is the stored id count, not what survived.
  const named = campaign.scope === 'product' || campaign.scope === 'products'
    ? (campaign.productIds ?? (campaign.productId ? [campaign.productId] : [])).length
    : covered.length;
  const onShelf = covered.filter(isProductVisible);
  // One pass over the feed's own rule, so `advertisable` and `policyBlocked` can never disagree
  // about the same product (product-feed.ts#adExclusionReason).
  const reasons = onShelf.map((p) => adExclusionReason(p, stripTrailingSlashes(platform.url)));
  return {
    total: named,
    live: onShelf.length,
    // The SAME base the feed endpoint resolves images against (api/feed/products.xml.ts), spelled
    // the same way — this count is a claim about what that endpoint will emit, so a second spelling
    // of its own origin is a second answer waiting to disagree.
    advertisable: reasons.filter((r) => r === null).length,
    // Counted apart from the rest of `advertisable` because it is a different KIND of problem: a
    // missing photo is his to fix in a minute, while prohibited content is the ad networks' own
    // list and is what suspends the shared account (ad-policy.ts). The card has to name it, and
    // the pause it causes is not one a sweep may undo.
    policyBlocked: reasons.filter((r) => r === 'policy').length,
    buyable: onShelf.filter((p) => p.stock > 0).length,
  };
}

/** Nothing left on the storefront at all — a human took it down, so only a human puts it back. */
export function isCampaignStarved(health: CampaignHealth): boolean {
  return health.live === 0;
}

/** Still listed, but nothing in it can be bought right now. Temporary by nature. */
function isCampaignSoldOut(health: CampaignHealth): boolean {
  return health.live > 0 && health.buyable === 0;
}

/** Still listed, but the ad platforms will not carry ANY of it — today that means no photo, which
 *  `image_link` makes a hard requirement (product-feed.ts#isProductAdvertisable). */
function isCampaignUnadvertisable(health: CampaignHealth): boolean {
  return health.live > 0 && health.advertisable === 0;
}

/** Why the platform stopped a running campaign — the states that get STORED on the row
 *  (migration 0016 widened the column's CHECK for the third). */
export type CampaignPauseReason = 'unavailable' | 'out-of-stock' | 'no-image';

/**
 * The reasons the platform undoes BY ITSELF once the cause clears.
 *
 * This is the axis the whole file turns on, and it is about WHO decided, not about severity: a
 * human took a product off the shelf, so a human restarts it ('unavailable'); a stock-out and a
 * missing photo are mechanical states nobody chose, and making the seller hunt for a "resume"
 * button after fixing one would be a penalty for fixing it.
 */
const SELF_HEALING_REASONS = ['out-of-stock', 'no-image'] as const;
type SelfHealingReason = typeof SELF_HEALING_REASONS[number];

function isSelfHealing(reason: string | undefined): reason is SelfHealingReason {
  return SELF_HEALING_REASONS.includes(reason as SelfHealingReason);
}

/** Why a campaign may not be switched on. Wider than the stored reasons: a finished campaign was
 *  never paused, it simply ran its course, so 'ended' blocks a resume without ever being written
 *  anywhere (ad-metrics.ts#isCampaignEnded derives it). */
export type CampaignBlockReason = CampaignPauseReason | 'ended';

/**
 * The refusal code a blocked resume travels to the browser as — one mapping, not one per route.
 *
 * The wording stays on the client because that is where the seller's language is known
 * (`scripts/dashboard/advertising.ts#errorText`); only the CODE crosses. The seller route and the
 * admin route each had their own copy of this chain, which is the shape this repo's review
 * checklist names as "the next bug" — and it was: adding the third reason meant editing both, and
 * a route left un-edited would have answered `CAMPAIGN_UNAVAILABLE` for a missing photo, telling
 * the seller a human must intervene on something that fixes itself.
 *
 * `Record`-typed rather than a chain, so a new `CampaignBlockReason` fails to compile until it has
 * a code — the compiler is what makes this exhaustive, not the reader.
 */
const RESUME_BLOCK_CODES: Record<CampaignBlockReason, string> = {
  unavailable: 'CAMPAIGN_UNAVAILABLE',
  'out-of-stock': 'CAMPAIGN_OUT_OF_STOCK',
  'no-image': 'CAMPAIGN_NO_IMAGE',
  ended: 'CAMPAIGN_ENDED',
};

export function resumeBlockCode(reason: CampaignBlockReason): string {
  return RESUME_BLOCK_CODES[reason];
}

/**
 * The single blocker to report, most fundamental first.
 *
 * 'no-image' outranks 'out-of-stock' on both counts that matter: a product with no photo is not in
 * the catalogue AT ALL (a sold-out one is, marked `out_of_stock`, and still collects the demand),
 * and uploading a photo is entirely in the seller's hands where restocking may not be. When both
 * are true he is told the one he can act on.
 */
function campaignBlockReason(health: CampaignHealth): CampaignPauseReason | null {
  if (isCampaignStarved(health)) return 'unavailable';
  // Prohibited content outranks every mechanical reason and is stamped 'unavailable' — the
  // permanent kind, which only a human undoes. Deliberately NOT self-healing: a term does not stop
  // being prohibited on its own, so a sweep that resumed the campaign would put the shared ad
  // account back at risk without anyone deciding to (ad-policy.ts).
  if (health.live > 0 && health.policyBlocked === health.live) return 'unavailable';
  if (isCampaignUnadvertisable(health)) return 'no-image';
  if (isCampaignSoldOut(health)) return 'out-of-stock';
  return null;
}

export type CampaignWithHealth = AdCampaign & { health: CampaignHealth };

/** What the read-time sweep may do to a campaign. A FIXED set of shapes, so a store's whole sweep
 *  is at most that many statements however many campaigns it runs — see `getCampaignsForStore`. */
type SweepAction = `pause-${CampaignPauseReason}` | `restamp-${CampaignPauseReason}` | 'resume';

const SWEEP_UPDATES: Record<SweepAction, CampaignUpdate> = {
  // Pausing is what freezes the accrued metrics at this moment rather than erasing them
  // (ad-metrics.ts#runPeriod) — `updateCampaigns` stamps `pausedAt` on the transition itself.
  'pause-unavailable': { status: 'paused', pausedReason: 'unavailable' },
  'pause-out-of-stock': { status: 'paused', pausedReason: 'out-of-stock' },
  'pause-no-image': { status: 'paused', pausedReason: 'no-image' },
  // Re-stamping keeps the STORED reason equal to the live one, because that reason is a promise the
  // card makes about who has to act. A sold-out campaign whose products then left the storefront
  // must stop saying "it comes back by itself"; a photo-less one that also sells out should name
  // the blocker the seller would actually hit next. Only ever between reasons the sweep may set —
  // and a stop a HUMAN caused never becomes self-healing because the symptom got milder, which is
  // what `isSelfHealing` below gates.
  'restamp-unavailable': { pausedReason: 'unavailable' },
  'restamp-out-of-stock': { pausedReason: 'out-of-stock' },
  'restamp-no-image': { pausedReason: 'no-image' },
  // The self-undoing half, and only back into the state the seller left it in. A campaign he paused
  // himself, or one the platform stopped because the products left the storefront, stays paused
  // until a human says otherwise — restarting spend without one is not a call this may make.
  resume: { status: 'active' },
};

function sweepAction(campaign: AdCampaign, blocked: CampaignPauseReason | null): SweepAction | null {
  if (campaign.status === 'active') return blocked ? `pause-${blocked}` : null;
  // Only a self-healing pause is the sweep's to touch at all.
  if (campaign.status !== 'paused' || !isSelfHealing(campaign.pausedReason)) return null;
  if (!blocked) return 'resume';
  return blocked === campaign.pausedReason ? null : `restamp-${blocked}`;
}

/** The store's products as a SHOPPER can BUY them. A store that cannot sell — admin-blocked
 *  (404s on every page), closed, or paused by its own seller (store-status.ts) — has nothing a
 *  click can convert on, however healthy each product row looks on its own, which means every
 *  campaign it runs is buying traffic it cannot serve. Modelled as "the store has no reachable
 *  products" rather than as extra pause reasons: it is the same fact the product-level check
 *  already expresses, and it flows through the existing starve → pause → refuse-to-resume path
 *  unchanged. So a seller pausing their store also stops their boosts, without this file or
 *  store-lifecycle.ts having to know about each other. */
async function reachableProducts(storeId: string): Promise<StoreProduct[]> {
  const store = await getStoreById(storeId);
  if (!store) return getProductsByStoreId(storeId);
  // **A showcase store is excluded from the feed, so a campaign on one advertises nothing
  // (found 2026-08-06, the same join asked from the store side).** The feed's store filter is
  // `getIndexableStores` = visible AND NOT a demo store; this file only ever asked `canStoreSell`,
  // which a showcase store passes — they are deliberately browsable. So its products are in no
  // feed and its campaign read perfectly healthy. Submitting fabricated catalogue to Merchant
  // Center is a policy violation against the whole shared account (api/feed/products.xml.ts), so
  // the exclusion is not going away and the campaign is the side that has to know.
  //
  // Modelled as "no reachable products", like the cannot-sell case above and for the same reason:
  // it flows through the existing starve → pause 'unavailable' → refuse-to-resume path unchanged.
  // 'unavailable' is also the honest half of that path here — a demo store is a standing platform
  // decision, not a passing state, so there is nothing for a sweep to undo by itself.
  if (!canStoreSell(store) || isDemoStore(store)) return [];
  return getProductsByStoreId(storeId);
}

/** The store's campaigns, each with its current health — and any campaign that has nothing left
 *  to advertise paused on the way out.
 *
 *  The sweep runs HERE, on the read, rather than being hooked into every place a product can
 *  change (hide, block, delete, bulk delete, CSV import, a category removal that empties a
 *  scope). Those are many call sites and the next one would be forgotten; this is one, it is
 *  idempotent, and it is correct whatever caused the change. At the DB migration it becomes a
 *  predicate in the campaigns query (or a scheduled job) instead of a write on read —
 *  `DB_MIGRATION_PLAN.md`.
 *
 *  Scoped to ONE store on purpose: the admin's platform-wide roll-up (admin-ads.ts) reads every
 *  campaign across every store and must not turn into a sweep of the whole table on each page
 *  load. A starved campaign there stays listed as active until that store's own page is opened —
 *  a reporting lag measured in one page view, not a spend that keeps running, because nothing
 *  charges off that roll-up.
 *
 *  **Decide first, then write once per KIND (DB_MIGRATION_PLAN.md §8).** While campaigns were a
 *  file this loop rewrote the whole file per changed campaign, which was invisible; as queries it
 *  is the write-inside-a-loop shape — a bulk delete that empties ten campaigns would fire ten
 *  UPDATEs. The decisions below are pure, so they are all taken against the rows already in hand
 *  and applied as at most four statements no matter how many campaigns the store has.
 */
export async function getCampaignsForStore(storeId: string): Promise<CampaignWithHealth[]> {
  const [products, categories, campaigns] = await Promise.all([
    reachableProducts(storeId),
    getCategoriesByStoreId(storeId),
    getCampaignsByStoreId(storeId),
  ]);

  const ended: string[] = [];
  const todo = new Map<SweepAction, string[]>();
  const live: CampaignWithHealth[] = [];

  for (const campaign of campaigns) {
    const health = campaignHealth(campaign, products, categories);

    // Ran its course: a fixed-duration campaign that reached its last day is finished, not
    // stopped. It moves to the store's history on its own — its numbers are already frozen by
    // the run period, and leaving it in the live list would mean "your campaigns" slowly filling
    // with things that ended months ago.
    if (isCampaignEnded(campaign)) { ended.push(campaign.id); continue; }

    const action = sweepAction(campaign, campaignBlockReason(health));
    if (action) todo.set(action, [...(todo.get(action) ?? []), campaign.id]);
    live.push({ ...campaign, health });
  }

  // Disjoint id sets, so these do not contend for the same rows. Archiving is the only one whose
  // campaigns leave the live list entirely — they were skipped above and never reached it.
  const updated = await Promise.all([
    ...(ended.length ? [archiveCampaigns(storeId, ended).then(() => [])] : []),
    ...[...todo].map(([action, ids]) => updateCampaigns(storeId, ids, SWEEP_UPDATES[action])),
  ]);

  // The rows the database actually wrote replace the ones read a moment earlier, so the returned
  // status/pausedAt are the stored ones and not a local guess at what the UPDATE would do.
  const written = new Map(updated.flat().map((c) => [c.id, c]));
  return live.map((c) => { const w = written.get(c.id); return w ? { ...w, health: c.health } : c; });
}

/** How many past campaigns the history block shows. A DISPLAY cap, not a data one: the rows all
 *  stay, and everything that counts money reads them in full (platform-revenue.ts). This only
 *  stops a long-running store from rendering hundreds of cards into one <details> nobody scrolls
 *  to the bottom of. */
export const CAMPAIGN_HISTORY_LIMIT = 50;

/** The store's cancelled and finished campaigns, newest first, with the same health shape the
 *  live ones carry so one renderer draws both. Read-only by construction — nothing here sweeps,
 *  resumes or re-budgets. */
export async function getCampaignHistory(storeId: string): Promise<CampaignWithHealth[]> {
  const [products, categories, archived] = await Promise.all([
    reachableProducts(storeId),
    getCategoriesByStoreId(storeId),
    getArchivedByStoreId(storeId),
  ]);
  return archived.slice(0, CAMPAIGN_HISTORY_LIMIT).map((campaign) => ({
    ...campaign,
    health: campaignHealth(campaign, products, categories),
  }));
}

/** May this campaign be switched back on, and if not, why? Resuming is the one status change
 *  that can start spending again, so it is refused while there is nothing to advertise (404) or
 *  nothing to buy (sold out) — otherwise the automatic pause above is undone by one button and
 *  the budget goes back to buying clicks nobody can convert. The two reasons are told apart
 *  because they need different sentences: one asks the seller to do something, the other tells
 *  him to wait.
 *
 *  Lives here rather than in each route: it was the same seven lines in both, and a guard that
 *  exists twice is one that gets relaxed once. An unknown id passes — the update itself then
 *  fails on its own ownership check, which is the error the caller should see.
 */
export async function resumeBlockReason(storeId: string, campaignId: string): Promise<CampaignBlockReason | null> {
  const current = (await getCampaignsForStore(storeId)).find((c) => c.id === campaignId);
  // Not in the live list: either it is history (finished or cancelled — over either way), or the
  // id is not this store's, which the update's own ownership check reports better than we can.
  if (!current) {
    const inHistory = (await getArchivedByStoreId(storeId)).some((c) => c.id === campaignId);
    return inHistory ? 'ended' : null;
  }
  // Its budget was for a period that is over, and restarting would silently buy another one.
  // Launching again is a new decision, and the form above is where it gets made.
  if (isCampaignEnded(current)) return 'ended';
  return campaignBlockReason(current.health);
}
