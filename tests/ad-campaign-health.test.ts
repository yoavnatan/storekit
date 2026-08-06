import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { readFileSync } from 'node:fs';
import {
  CAMPAIGN_HISTORY_LIMIT, campaignHealth, getCampaignHistory, getCampaignsForStore,
  isCampaignStarved, resumeBlockReason, resumeBlockCode,
} from '../src/lib/ad-campaign-health.js';
import { campaignHealthNote } from '../src/lib/ad-scope-label.js';
import { translations } from '../src/i18n/translations.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

/** A campaign names what it advertises once, at launch, and then keeps running — while the
 *  catalog underneath it keeps moving. These cover the gap that opens when it does: a product
 *  the seller takes off the shelf, one an admin blocks, one deleted outright, and a category
 *  emptied. Without this the platform goes on buying clicks to a page that 404s.
 */

const CATEGORIES: StoreCategory[] = [
  { id: 'c-shoes', storeId: 's1', name: 'נעליים', parentId: null, order: 0, createdAt: '2026-07-01' },
  { id: 'c-sport', storeId: 's1', name: 'ספורט', parentId: 'c-shoes', order: 0, createdAt: '2026-07-01' },
  { id: 'c-bags', storeId: 's1', name: 'תיקים', parentId: null, order: 1, createdAt: '2026-07-01' },
];

// A photo and a real price, because without either the ad platforms will not carry the product at
// all and `advertisable` (not `live`) is what says so — see the "no photo" case at the end.
const product = (id: string, extra: Partial<StoreProduct> = {}): StoreProduct =>
  ({ id, storeId: 's1', name: id, stock: 5, price: 100, images: ['https://cdn.example/x.jpg'], ...extra }) as StoreProduct;

const campaign = (extra: Partial<AdCampaign>): AdCampaign =>
  ({ id: 'camp', storeId: 's1', storeSlug: 's', scope: 'store', platform: 'both', monthlyBudgetAgorot: 20_000,
     status: 'active', createdAt: '2026-07-01', updatedAt: '2026-07-01', ...extra }) as AdCampaign;

describe('campaignHealth — named products', () => {
  const c = campaign({ scope: 'products', productIds: ['p1', 'p2', 'p3'], productNames: ['a', 'b', 'c'] });

  it('counts only what a shopper can still reach', () => {
    const products = [product('p1'), product('p2', { hidden: true }), product('p3', { blocked: true })];
    expect(campaignHealth(c, products, CATEGORIES)).toEqual({ total: 3, live: 1, advertisable: 1, policyBlocked: 0, buyable: 1 });
  });

  it('counts a DELETED product as gone, not as one fewer target', () => {
    // The stored id list is what the seller chose, so a product that no longer exists has to
    // read as "1 of 3 lost" — measuring `total` off the surviving rows would report 2 of 2 and
    // the card would say nothing is wrong.
    expect(campaignHealth(c, [product('p1'), product('p2')], CATEGORIES)).toEqual({ total: 3, live: 2, advertisable: 2, policyBlocked: 0, buyable: 2 });
  });

  it('starves only when nothing is left', () => {
    const allGone = [product('p1', { blocked: true }), product('p2', { hidden: true })];
    expect(isCampaignStarved(campaignHealth(c, allGone, CATEGORIES))).toBe(true);
    expect(isCampaignStarved(campaignHealth(c, [product('p1')], CATEGORIES))).toBe(false);
  });

  it('reads a legacy single-product row through its flat productId', () => {
    const legacy = campaign({ scope: 'product', productId: 'p9', productName: 'old' });
    expect(campaignHealth(legacy, [product('p9', { blocked: true })], CATEGORIES)).toEqual({ total: 1, live: 0, advertisable: 0, policyBlocked: 0, buyable: 0 });
  });

  // `live` is about the listing, `buyable` about the shelf — a sold-out product is still ON the
  // storefront, which is what keeps the two pauses (permanent vs temporary) apart.
  it('counts a sold-out product as live but not buyable', () => {
    const health = campaignHealth(c, [product('p1', { stock: 0 }), product('p2'), product('p3')], CATEGORIES);
    expect(health).toEqual({ total: 3, live: 3, advertisable: 3, policyBlocked: 0, buyable: 2 });
  });

  // A product with no photo is on the shelf and NOT in Merchant Center — `image_link` is a required
  // attribute (product-feed.ts#isProductAdvertisable). Until 2026-08-06 the card counted it as
  // advertised, so a campaign reported more coverage than it had.
  it('counts a product with no photo as live but not advertisable', () => {
    const health = campaignHealth(c, [product('p1', { images: [] }), product('p2'), product('p3')], CATEGORIES);
    expect(health).toEqual({ total: 3, live: 3, advertisable: 2, policyBlocked: 0, buyable: 3 });
  });

  it('counts a zero-priced product as live but not advertisable', () => {
    const health = campaignHealth(c, [product('p1', { price: 0 }), product('p2'), product('p3')], CATEGORIES);
    expect(health.advertisable).toBe(2);
  });

  it('does NOT starve a campaign whose products merely lack photos', () => {
    // Starving pauses as 'unavailable' and then waits for a human. A missing photo is mechanical
    // and temporary — the wrong kind of stop to demand a person clear by hand.
    const noPhotos = [product('p1', { images: [] }), product('p2', { images: [] })];
    expect(isCampaignStarved(campaignHealth(c, noPhotos, CATEGORIES))).toBe(false);
  });
});

describe('campaignHealth — categories and whole store', () => {
  it('covers a picked category AND everything beneath it', () => {
    const c = campaign({ scope: 'categories', categoryIds: ['c-shoes'], categoryNames: ['נעליים'] });
    const products = [product('p1', { categoryId: 'c-shoes' }), product('p2', { categoryId: 'c-sport' }), product('p3', { categoryId: 'c-bags' })];
    expect(campaignHealth(c, products, CATEGORIES)).toEqual({ total: 2, live: 2, advertisable: 2, policyBlocked: 0, buyable: 2 });
  });

  it('starves a category campaign once its products leave the storefront', () => {
    const c = campaign({ scope: 'categories', categoryIds: ['c-bags'], categoryNames: ['תיקים'] });
    const products = [product('p1', { categoryId: 'c-bags', hidden: true }), product('p2', { categoryId: 'c-shoes' })];
    expect(isCampaignStarved(campaignHealth(c, products, CATEGORIES))).toBe(true);
  });

  it('starves a store-wide campaign only when the whole store is off the shelf', () => {
    const c = campaign({ scope: 'store' });
    expect(isCampaignStarved(campaignHealth(c, [product('p1', { blocked: true })], CATEGORIES))).toBe(true);
    expect(isCampaignStarved(campaignHealth(c, [product('p1', { blocked: true }), product('p2')], CATEGORIES))).toBe(false);
  });
});

describe('campaignHealthNote', () => {
  const L = {
    adHealthStarved: 'הושהה — אין מוצר זמין',
    adHealthSoldOut: 'הושהה זמנית — הכל אזל',
    adHealthPartial: '{gone} מתוך {total} ירדו מהמדף',
    adHealthPartialStock: '{gone} מתוך {total} אזלו מהמלאי',
    adHealthNoImage: '{gone} מתוך {total} בלי תמונה',
    adHealthNoImageStopped: 'הושהה זמנית — אין תמונה לאף מוצר',
    adHealthPolicyBlocked: '{gone} מוצרים אסורים לפרסום',
  };

  it('says the platform stopped it, when the platform stopped it', () => {
    expect(campaignHealthNote({ total: 2, live: 0 }, 'unavailable', L)).toBe('הושהה — אין מוצר זמין');
  });

  it('reports the gap on a campaign still running on what is left', () => {
    expect(campaignHealthNote({ total: 3, live: 1 }, undefined, L)).toBe('2 מתוך 3 ירדו מהמדף');
  });

  it('tells a temporary stop apart from a permanent one', () => {
    expect(campaignHealthNote({ total: 1, live: 1, buyable: 0 }, 'out-of-stock', L)).toBe('הושהה זמנית — הכל אזל');
  });

  it('reports a partial sell-out on a campaign still running', () => {
    expect(campaignHealthNote({ total: 3, live: 3, buyable: 1 }, undefined, L)).toBe('2 מתוך 3 אזלו מהמלאי');
  });

  // Both at once: the shelf is the bigger problem and the one line goes to it.
  it('leads with the off-shelf count when products are both gone and sold out', () => {
    expect(campaignHealthNote({ total: 4, live: 2, buyable: 1 }, undefined, L)).toBe('2 מתוך 4 ירדו מהמדף');
  });

  // The stored reason and the live counts can disagree: a product put back on the shelf but sold
  // out still carries "unavailable". Telling him to put it back would be telling him to redo
  // what he just did.
  it('believes the live counts over a stale stored reason', () => {
    expect(campaignHealthNote({ total: 1, live: 1, buyable: 0 }, 'unavailable', L)).toBe('הושהה זמנית — הכל אזל');
  });

  // A STOPPED photo-less campaign gets its own line, not the sold-out one — the whole reason the
  // third stored reason exists.
  it('names the photo when the platform stopped it for that', () => {
    expect(campaignHealthNote({ total: 1, live: 1, advertisable: 0, buyable: 1 }, 'no-image', L))
      .toBe('הושהה זמנית — אין תמונה לאף מוצר');
  });

  it('never calls a photo stop a stock stop, even when it is also sold out', () => {
    expect(campaignHealthNote({ total: 1, live: 1, advertisable: 0, buyable: 0 }, 'no-image', L))
      .toBe('הושהה זמנית — אין תמונה לאף מוצר');
  });

  it('still believes the live counts over a stale stored reason', () => {
    // Paused for no photo, photo since uploaded, now sold out: the card must move to the stock line
    // rather than telling him to upload a photo he already uploaded.
    expect(campaignHealthNote({ total: 1, live: 1, advertisable: 1, buyable: 0 }, 'no-image', L))
      .toBe('הושהה זמנית — הכל אזל');
  });

  // The only line on this card that is about the shared ad ACCOUNT rather than this campaign's
  // reach, so it outranks every mechanical one — he needs to know WHICH listing endangers everyone.
  it('names a policy-blocked product above a missing photo and above a sell-out', () => {
    expect(campaignHealthNote({ total: 4, live: 4, advertisable: 2, policyBlocked: 1, buyable: 2 }, undefined, L))
      .toBe('1 מוצרים אסורים לפרסום');
  });

  it('says so on a campaign the platform stopped entirely for it', () => {
    expect(campaignHealthNote({ total: 1, live: 1, advertisable: 0, policyBlocked: 1, buyable: 1 }, 'unavailable', L))
      .toBe('1 מוצרים אסורים לפרסום');
  });

  it('still leads with the off-shelf count, which explains why the campaign shrank', () => {
    expect(campaignHealthNote({ total: 4, live: 2, advertisable: 1, policyBlocked: 1, buyable: 2 }, undefined, L))
      .toBe('2 מתוך 4 ירדו מהמדף');
  });

  it('reports products the ad platforms cannot carry, on a campaign still running', () => {
    expect(campaignHealthNote({ total: 3, live: 3, advertisable: 1, buyable: 3 }, undefined, L)).toBe('2 מתוך 3 בלי תמונה');
  });

  // Both apply and one line shows: uploading a photo is entirely in his hands, where a stock-out
  // resolves itself, so the actionable one wins.
  it('leads with the missing photo over a partial sell-out', () => {
    expect(campaignHealthNote({ total: 4, live: 4, advertisable: 3, buyable: 2 }, undefined, L)).toBe('1 מתוך 4 בלי תמונה');
  });

  it('still leads with the off-shelf count, which outranks both', () => {
    expect(campaignHealthNote({ total: 4, live: 2, advertisable: 1, buyable: 1 }, undefined, L)).toBe('2 מתוך 4 ירדו מהמדף');
  });

  it('says nothing at all when nothing is wrong', () => {
    expect(campaignHealthNote({ total: 3, live: 3, advertisable: 3, buyable: 3 }, undefined, L)).toBe('');
    expect(campaignHealthNote(undefined, undefined, L)).toBe('');
  });
});

/** The functions above only DECIDE. `getCampaignsForStore` is what acts on the decision, and it is
 *  the half that carries risk: it WRITES during a read, on every dashboard load and every 15s poll.
 *  Two properties have to hold or that write is a liability — it must fire only when a campaign
 *  actually needs pausing, and it must not fire again once it has.
 *
 *  **These ran against a mock of `ad-campaigns.ts` until it moved to Postgres, and that mock was
 *  the whole module.** It reimplemented the accessors over an in-memory array, so what they proved
 *  was that the fixture behaved — a real module returning an empty list for every store left all
 *  of them green (measured: 1784 of 1785 tests survived stubbing its I/O). They run against the
 *  real table now. The three mocks that remain are the modules this file is NOT testing: products,
 *  categories and the store record are inputs to the health decision, and holding them in memory
 *  is what keeps each case one readable line.
 *
 *  `writes` is gone with the mock; "a dashboard load is a read" is now asserted the way the
 *  database can answer it — `updated_at` on every one of the store's rows, before and after. */
const STORE = { id: '', blocked: false };

/** Every test gets its own store, seller and category tree, so a sweep in one cannot reach
 *  another's rows. Nothing here is mocked: products, categories and the store record have all
 *  moved to Postgres, so the honest fixture is rows — and mocking them would need
 *  `vi.resetModules()`, which hands the module graph a fresh `src/lib/db.ts` without the test
 *  database installed in it. */
let seq = 0;
const CATEGORY_IDS = new Map<string, string>();

beforeEach(async () => {
  seq += 1;
  const sellerId = crypto.randomUUID();
  STORE.id = crypto.randomUUID();
  STORE.blocked = false;
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${STORE.id}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [STORE.id, sellerId, `health-${seq}-${crypto.randomBytes(3).toString('hex')}`]);

  // Fresh id maps per test: the readable names below ('c1', 'p1') are reused everywhere, and a
  // name that kept its uuid across tests would collide on the primary key the second time.
  uuidFor.clear();
  PRODUCT_IDS.clear();

  // The same three-node tree the pure tests above use, as real rows: shoes → sport, and bags.
  CATEGORY_IDS.clear();
  for (const c of CATEGORIES) {
    CATEGORY_IDS.set(c.id, crypto.randomUUID());
  }
  for (const c of CATEGORIES) {
    await query(`INSERT INTO store_categories (id, store_id, parent_id, name, position) VALUES ($1, $2, $3, $4, $5)`,
      [CATEGORY_IDS.get(c.id), STORE.id, c.parentId ? CATEGORY_IDS.get(c.parentId) : null, c.name, c.order]);
  }
});

/** Block the store the way an admin does — `canStoreSell` reads the row, so this is a real UPDATE
 *  rather than a flag on a fake. */
async function blockStore(): Promise<void> {
  STORE.blocked = true;
  await query('UPDATE stores SET blocked = true WHERE id = $1', [STORE.id]);
}

/** A product on this store's shelf. `stock`/`hidden`/`blocked` are what the health rules read. */
const PRODUCT_IDS = new Map<string, string>();
const productIdOf = (name: string): string => {
  if (!PRODUCT_IDS.has(name)) PRODUCT_IDS.set(name, crypto.randomUUID());
  return PRODUCT_IDS.get(name)!;
};

async function stock(name: string, extra: { stock?: number; hidden?: boolean; blocked?: boolean; categoryId?: string; noImage?: boolean } = {}): Promise<void> {
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock, hidden, blocked, category_id)
     VALUES ($1, $2, $3, $4, 10000, $5, $6, $7, $8)`,
    [
      productIdOf(name), STORE.id, name, name,
      extra.stock ?? 5, extra.hidden ?? false, extra.blocked ?? false,
      extra.categoryId ? CATEGORY_IDS.get(extra.categoryId) ?? null : null,
    ],
  );
  // A photo by default: `image_link` is required by both platforms, so a product without one is
  // live on the storefront and absent from the feed, and `advertisable` is what reports that.
  if (!extra.noImage) {
    await query(
      'INSERT INTO product_images (product_id, position, url) VALUES ($1, 0, $2)',
      [productIdOf(name), 'https://cdn.example/x.jpg'],
    );
  }
}

/** Put a campaign in the table. Ids stay the short readable strings the cases below name; the
 *  column needs a uuid, so the two are kept in a map and translated back on the way out. */
const uuidFor = new Map<string, string>();
const idOf = (name: string): string => {
  if (!uuidFor.has(name)) uuidFor.set(name, crypto.randomUUID());
  return uuidFor.get(name)!;
};
const nameOf = (id: string): string => [...uuidFor].find(([, v]) => v === id)?.[0] ?? id;

async function seed(...campaigns: AdCampaign[]): Promise<void> {
  for (const c of campaigns) {
    await query(
      `INSERT INTO ad_campaigns (id, store_id, store_slug, scope, product_id, product_name,
         product_ids, product_names, category_ids, category_names, platform,
         monthly_budget_agorot, duration_days, status, paused_at, paused_reason, archived_at,
         created_at, updated_at)
       VALUES ($1,$2,'s',$3,$4,$5,$6,$7,$8,$9,'both',$10,$11,$12,$13,$14,$15,$16,$16)`,
      [
        idOf(c.id), c.storeId === 's2' ? await otherStore() : STORE.id, c.scope,
        c.productId ? productIdOf(c.productId) : null, c.productName ?? null,
        (c.productIds ?? []).map(productIdOf), c.productNames ?? [],
        (c.categoryIds ?? []).map((id) => CATEGORY_IDS.get(id) ?? id), c.categoryNames ?? [],
        c.monthlyBudgetAgorot, c.durationDays ?? null, c.status,
        c.pausedAt ?? null, c.pausedReason ?? null, c.archivedAt ?? null, c.createdAt,
      ],
    );
  }
}

/** A second store, for the "never touches anybody else's rows" case. */
async function otherStore(): Promise<string> {
  const sellerId = crypto.randomUUID();
  const storeId = crypto.randomUUID();
  await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')`,
    [sellerId, `${storeId}@example.test`]);
  await query(`INSERT INTO stores (id, seller_id, slug, name) VALUES ($1, $2, $3, 'T')`,
    [storeId, sellerId, `other-${crypto.randomBytes(4).toString('hex')}`]);
  return storeId;
}

/** Every row of this store, as (name, updated_at) — the probe that replaces the mock's write log. */
async function stamps(): Promise<Record<string, string>> {
  const { rows } = await query<{ id: string; updated_at: Date | string }>(
    'SELECT id, updated_at FROM ad_campaigns WHERE store_id = $1', [STORE.id]);
  return Object.fromEntries(rows.map((r) => [nameOf(r.id), String(r.updated_at)]));
}

/** How many rows this store has at all, live or history. */
async function rowCount(): Promise<number> {
  const { rows } = await query<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM ad_campaigns WHERE store_id = $1', [STORE.id]);
  return Number(rows[0]!.n);
}

const load = async () =>
  (await getCampaignsForStore(STORE.id)).map((c) => ({ ...c, id: nameOf(c.id) }));
const history = async () =>
  (await getCampaignHistory(STORE.id)).map((c) => ({ ...c, id: nameOf(c.id) }));
const blockedFor = (name: string): Promise<string | null> => resumeBlockReason(STORE.id, idOf(name));

describe('getCampaignsForStore — the automatic pause', () => {
  it('pauses a campaign with nothing left, and records that the platform did it', async () => {
    await seed(campaign({ id: 'dead', scope: 'products', productIds: ['gone'] }));
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('unavailable');
    // The pause moment is stamped by the same statement — it is what freezes the accrued metrics.
    expect(row?.pausedAt).toBeTruthy();
  });

  it('writes NOTHING when the campaign is healthy — a dashboard load is a read', async () => {
    await stock('p1');
    await seed(campaign({ id: 'ok', scope: 'products', productIds: ['p1'] }));
    const before = await stamps();
    expect((await load())[0]?.status).toBe('active');
    expect(await stamps()).toEqual(before);
  });

  // Without this the poll would rewrite the row every 15 seconds, forever, for a campaign that is
  // already paused.
  it('does not re-pause what it already paused', async () => {
    await seed(campaign({ id: 'dead', status: 'paused', pausedReason: 'unavailable', scope: 'products', productIds: ['gone'] }));
    const before = await stamps();
    expect((await load())[0]?.status).toBe('paused');
    expect(await stamps()).toEqual(before);
  });

  it('leaves a campaign that is still partly alive running, rather than narrowing it', async () => {
    await stock('p1');
    await stock('p2', { hidden: true });
    await seed(campaign({ id: 'partial', scope: 'products', productIds: ['p1', 'p2'] }));
    const before = await stamps();
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.health).toEqual({ total: 2, live: 1, advertisable: 1, policyBlocked: 0, buyable: 1 });
    expect(await stamps()).toEqual(before);
  });

  it('never reads or writes another store\'s campaigns', async () => {
    await seed(campaign({ id: 'theirs', storeId: 's2', scope: 'products', productIds: ['gone'] }));
    expect(await load()).toEqual([]);
    expect(await stamps()).toEqual({});
  });

  // The sweep decides in memory and writes once per KIND, so a catalog change that starves ten
  // campaigns at once is four statements rather than ten (DB_MIGRATION_PLAN.md §8).
  it('pauses a whole batch of starved campaigns in one pass', async () => {
    await seed(
      campaign({ id: 'd1', scope: 'products', productIds: ['gone'] }),
      campaign({ id: 'd2', scope: 'products', productIds: ['gone'] }),
      campaign({ id: 'd3', scope: 'products', productIds: ['gone'] }),
    );
    const rows = await load();
    expect(rows).toHaveLength(3);
    expect(rows.every((c) => c.status === 'paused' && c.pausedReason === 'unavailable')).toBe(true);
  });
});

describe('resumeBlockReason', () => {
  // The guard both routes call. It is what stops an automatic pause from being undone by one
  // click, so it is tested here rather than through either route.
  it('refuses while nothing it advertises is on the storefront', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    await stock('p1', { hidden: true });
    expect(await blockedFor('c1')).toBe('unavailable');
  });

  it('refuses while everything in it is sold out, and says so distinctly', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    await stock('p1', { stock: 0 });
    expect(await blockedFor('c1')).toBe('out-of-stock');
  });

  it('allows it once the product is back on the shelf and in stock', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    await stock('p1');
    expect(await blockedFor('c1')).toBeNull();
  });

  it('passes an unknown id through, so the update reports the real error', async () => {
    expect(await blockedFor('nope')).toBeNull();
  });
});

/** The stock half, which is the one that undoes itself. */
describe('getCampaignsForStore — sold out', () => {
  it('pauses a campaign whose products are all sold out, marked as the temporary kind', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1', { stock: 0 });
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('out-of-stock');
  });

  it('starts it again BY ITSELF once stock returns', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'out-of-stock' }));
    await stock('p1', { stock: 3 });
    const [row] = await load();
    expect(row?.status).toBe('active');
    // Cleared with it — a running campaign still carrying "paused because sold out" would resume
    // itself forever.
    expect(row?.pausedReason).toBeUndefined();
    expect(row?.pausedAt).toBeUndefined();
  });

  // The whole point of telling the two pauses apart: a seller who pressed pause, or a product a
  // human took off the shelf, must NOT be overridden by a stock delivery.
  it('never resumes a campaign the seller paused himself', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    await stock('p1', { stock: 3 });
    const before = await stamps();
    expect((await load())[0]?.status).toBe('paused');
    expect(await stamps()).toEqual(before);
  });

  it('never resumes one the platform stopped for being off the storefront', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    await stock('p1', { stock: 3 });
    expect((await load())[0]?.status).toBe('paused');
  });

  it('keeps a partly-sold-out campaign running on what is left', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1', 'p2'] }));
    await stock('p1', { stock: 0 });
    await stock('p2', { stock: 4 });
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.health).toEqual({ total: 2, live: 2, advertisable: 2, policyBlocked: 0, buyable: 1 });
  });

  // 'out-of-stock' is a promise the card makes ("it comes back by itself"). Once the product
  // leaves the storefront that promise is false, so the stored reason has to follow.
  it('upgrades a stock pause to a permanent one when the product then leaves the shelf', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'out-of-stock', pausedAt: '2026-07-01T00:00:00.000Z' }));
    await stock('p1', { stock: 0, hidden: true });
    const [row] = await load();
    expect(row?.pausedReason).toBe('unavailable');
    // Only the reason changes: the campaign stopped when it stopped, and re-stamping the moment
    // would move the boundary its frozen metrics are measured to.
    expect(row?.pausedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  // ...and never the other way: a stop a human caused stays his to undo, even when the current
  // symptom is the milder one.
  it('never downgrades a permanent pause into a self-healing one', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    await stock('p1', { stock: 0 });
    const [row] = await load();
    expect(row?.pausedReason).toBe('unavailable');
    expect(row?.status).toBe('paused');
  });

  it('reports being off the shelf, not merely sold out, when it is both', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1', { stock: 0, hidden: true });
    expect((await load())[0]?.pausedReason).toBe('unavailable');
  });
});

/**
 * The third reason (owner's decision 2026-08-06, migration 0016). `image_link` is a REQUIRED
 * Merchant/Catalog attribute, so a product with no photo is not in the catalogue at all — the
 * campaign was reading "פעיל" while advertising literally nothing.
 *
 * It is SELF-HEALING like a stock-out, because uploading a photo clears it and making the seller
 * then hunt for a resume button would be a penalty for fixing it. But it could not BE 'out-of-stock'
 * — that would print "אזל מהמלאי" on a card about a photo, which is a false statement to the seller
 * about his own shop in the one place he goes to find out why his ad stopped.
 */
describe('getCampaignsForStore — no photo', () => {
  it('pauses a campaign none of whose products the ad platforms can carry', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1', { noImage: true });
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('no-image');
  });

  it('starts it again BY ITSELF once a photo exists', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'no-image' }));
    await stock('p1');
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.pausedReason).toBeUndefined();
    expect(row?.pausedAt).toBeUndefined();
  });

  it('keeps a partly photo-less campaign running on what is left', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1', 'p2'] }));
    await stock('p1', { noImage: true });
    await stock('p2');
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.health).toEqual({ total: 2, live: 2, advertisable: 1, policyBlocked: 0, buyable: 2 });
  });

  // The reason this needed a value of its own rather than reusing the stock one.
  it('never labels a photo problem as a stock problem', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1', { noImage: true, stock: 9 });
    expect((await load())[0]?.pausedReason).toBe('no-image');
  });

  it('reports the photo, not the stock, when it is both — it is the one he can act on', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1', { noImage: true, stock: 0 });
    expect((await load())[0]?.pausedReason).toBe('no-image');
  });

  it('still reports being off the shelf above either — that one only a human undoes', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1', { noImage: true, hidden: true });
    expect((await load())[0]?.pausedReason).toBe('unavailable');
  });

  // Both stored reasons are self-healing, so the sweep may move BETWEEN them — the stored reason is
  // the promise the card makes, and it has to name the blocker that is true now.
  it('re-stamps a photo pause as a stock pause once the photo arrives and stock has gone', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'no-image', pausedAt: '2026-07-01T00:00:00.000Z' }));
    await stock('p1', { stock: 0 });
    const [row] = await load();
    expect(row?.pausedReason).toBe('out-of-stock');
    expect(row?.status).toBe('paused');
    // The campaign stopped when it stopped; re-stamping the moment would move the boundary its
    // frozen metrics are measured to.
    expect(row?.pausedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('upgrades a photo pause to a permanent one when the product leaves the shelf', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'no-image' }));
    await stock('p1', { noImage: true, hidden: true });
    expect((await load())[0]?.pausedReason).toBe('unavailable');
  });

  it('never downgrades a human pause into it', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    await stock('p1', { noImage: true });
    const [row] = await load();
    expect(row?.pausedReason).toBe('unavailable');
    expect(row?.status).toBe('paused');
  });

  it('refuses a manual resume while it still has no photo, and says which kind', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'no-image' }));
    await stock('p1', { noImage: true });
    expect(await blockedFor('c1')).toBe('no-image');
  });
});

/**
 * The floor under a store that BECOMES a showcase store.
 *
 * `buildCampaignInput` refuses to CREATE one (tests/ad-campaign-scope.test.ts) — this is the other
 * end: a campaign that already exists when the flag is set must stop, not go on reading healthy.
 * The bug was that this file asked only `canStoreSell`, which a showcase store passes (they are
 * deliberately browsable), while the feed's own filter is `getIndexableStores` = visible AND NOT a
 * demo store. Same shape as everything else in this area: both predicates correct on their own,
 * only the JOIN between them wrong.
 */
describe('getCampaignsForStore — a showcase store advertises nothing', () => {
  it('starves a campaign on a store flagged as a showcase, however healthy its products are', async () => {
    await seed(campaign({ id: 'c1', scope: 'store' }));
    await stock('p1');
    await query('UPDATE stores SET demo = true WHERE id = $1', [STORE.id]);
    const [row] = await load();
    expect(row?.status).toBe('paused');
    // 'unavailable', not a self-healing reason: a showcase store is a standing platform decision,
    // so there is nothing for a sweep to undo by itself.
    expect(row?.pausedReason).toBe('unavailable');
    expect(row?.health).toEqual({ total: 0, live: 0, advertisable: 0, policyBlocked: 0, buyable: 0 });
  });

  it('refuses a manual resume on one', async () => {
    await seed(campaign({ id: 'c1', scope: 'store', status: 'paused', pausedReason: 'unavailable' }));
    await stock('p1');
    await query('UPDATE stores SET demo = true WHERE id = $1', [STORE.id]);
    expect(await blockedFor('c1')).toBe('unavailable');
  });

  it('leaves an ordinary store running', async () => {
    await seed(campaign({ id: 'c1', scope: 'store' }));
    await stock('p1');
    expect((await load())[0]?.status).toBe('active');
  });
});

/**
 * The refusal code, and the reason it is ONE mapping.
 *
 * The seller route and the admin route each carried their own copy of the reason→code chain, so
 * adding this third reason meant editing both — and a route left un-edited would have answered
 * `CAMPAIGN_UNAVAILABLE` for a missing photo, i.e. told the seller a human must intervene on
 * something that fixes itself. `resumeBlockCode` is now the single definition; these two tests are
 * what stops the next reason from being added without a code or without the client wording.
 */
describe('resumeBlockCode', () => {
  const REASONS = ['unavailable', 'out-of-stock', 'no-image', 'ended'] as const;

  it('gives every block reason a distinct code', () => {
    const codes = REASONS.map(resumeBlockCode);
    expect(codes.every(Boolean)).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every code the API can answer with has seller-facing wording on the client', () => {
    // The server sends a CODE and the dashboard turns it into the seller's language
    // (scripts/dashboard/advertising.ts#errorText). A code with no entry there renders the raw
    // token — an English constant in a Hebrew dashboard, on the one screen that explains why his
    // ad stopped. Read from the source rather than mirrored, so this cannot pass on a stale copy.
    const client = readFileSync(new URL('../src/scripts/dashboard/advertising.ts', import.meta.url), 'utf8');
    const he = translations.he.dashboard as unknown as Record<string, string>;
    const en = translations.en.dashboard as unknown as Record<string, string>;
    for (const reason of REASONS) {
      const code = resumeBlockCode(reason);
      const mapped = new RegExp(`${code}:\\s*i18n\\.(\\w+)`).exec(client);
      expect(mapped, `${code} has no entry in errorText`).not.toBeNull();
      const key = mapped![1]!;
      expect(he[key], `${key} missing from the Hebrew dashboard strings`).toBeTruthy();
      expect(en[key], `${key} missing from the English dashboard strings`).toBeTruthy();
    }
  });
});

/** Cancelling and finishing — the half that decides whether a campaign's spend survives it. */
describe('history: cancelled and finished campaigns', () => {
  // A fixed-duration campaign from last month: its own end date is in the past.
  const finished = (extra: Partial<AdCampaign> = {}): AdCampaign =>
    campaign({ id: 'old', durationDays: 7, createdAt: '2026-01-01T00:00:00.000Z', ...extra });

  it('moves a campaign that ran its course into history, by itself', async () => {
    await seed(finished({ scope: 'products', productIds: ['p1'] }));
    await stock('p1');
    expect(await load()).toEqual([]);                       // gone from "your campaigns"
    expect((await history()).map((c) => c.id)).toEqual(['old']); // but still on record
    expect(await rowCount()).toBe(1);
  });

  it('never resumes a finished campaign — that budget was for a period that is over', async () => {
    await seed(finished({ status: 'paused', scope: 'products', productIds: ['p1'] }));
    await stock('p1');
    expect(await blockedFor('old')).toBe('ended');
  });

  it('leaves an ONGOING campaign alone however old it is', async () => {
    await seed(campaign({ id: 'ongoing', createdAt: '2026-01-01T00:00:00.000Z', scope: 'products', productIds: ['p1'] }));
    await stock('p1');
    expect((await load()).map((c) => c.id)).toEqual(['ongoing']);
  });

  it('keeps history out of the live list and the live list out of history', async () => {
    await seed(
      campaign({ id: 'live', scope: 'products', productIds: ['p1'] }),
      campaign({ id: 'cancelled', status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z', scope: 'products', productIds: ['p1'] }),
    );
    await stock('p1');
    expect((await load()).map((c) => c.id)).toEqual(['live']);
    expect((await history()).map((c) => c.id)).toEqual(['cancelled']);
  });

  // The reason the row is kept at all: every reported figure is derived from the campaign list,
  // so a cancelled campaign that has left the dashboard must still be there to be summed.
  it('a cancelled campaign is still a campaign for anything that counts money', async () => {
    await seed(campaign({ id: 'cancelled', status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z' }));
    expect((await history()).map((c) => c.id)).toEqual(['cancelled']);
  });

  it('refuses to resume anything that is already in history', async () => {
    await seed(campaign({ id: 'cancelled', status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z' }));
    expect(await blockedFor('cancelled')).toBe('ended');
  });

  // The block is a display surface, not the ledger: it caps what it draws, while the rows behind
  // it stay whole for anything that sums money.
  it('caps how many past campaigns it draws, without dropping the rows', async () => {
    const many: AdCampaign[] = [];
    for (let n = 0; n < CAMPAIGN_HISTORY_LIMIT + 5; n++) {
      many.push(campaign({ id: `old-${n}`, status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z' }));
    }
    await seed(...many);
    expect((await history()).length).toBe(CAMPAIGN_HISTORY_LIMIT);
    expect(await rowCount()).toBe(CAMPAIGN_HISTORY_LIMIT + 5);
  });

  // A blocked store 404s on every page it has, so each of its campaigns is buying clicks to a
  // dead end — however healthy the individual product rows still look.
  it('stops every campaign of a store the admin blocked', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    await stock('p1');
    await blockStore();
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('unavailable');
    expect(row?.health).toEqual({ total: 1, live: 0, advertisable: 0, policyBlocked: 0, buyable: 0 });
  });

  it('lets them run again once the block is lifted — but only when a human says so', async () => {
    await seed(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    await stock('p1');
    expect((await load())[0]?.status).toBe('paused');   // not resumed for him
    expect(await blockedFor('c1')).toBeNull();          // but the button now works
  });
});
