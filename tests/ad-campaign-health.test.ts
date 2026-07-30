import { beforeEach, describe, expect, it, vi } from 'vitest';
import { campaignHealth, isCampaignStarved } from '../src/lib/ad-campaign-health.js';
import { campaignHealthNote } from '../src/lib/ad-scope-label.js';
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

const product = (id: string, extra: Partial<StoreProduct> = {}): StoreProduct =>
  ({ id, storeId: 's1', name: id, stock: 5, ...extra }) as StoreProduct;

const campaign = (extra: Partial<AdCampaign>): AdCampaign =>
  ({ id: 'camp', storeId: 's1', storeSlug: 's', scope: 'store', platform: 'both', monthlyBudget: 200,
     status: 'active', createdAt: '2026-07-01', updatedAt: '2026-07-01', ...extra }) as AdCampaign;

describe('campaignHealth — named products', () => {
  const c = campaign({ scope: 'products', productIds: ['p1', 'p2', 'p3'], productNames: ['a', 'b', 'c'] });

  it('counts only what a shopper can still reach', () => {
    const products = [product('p1'), product('p2', { hidden: true }), product('p3', { blocked: true })];
    expect(campaignHealth(c, products, CATEGORIES)).toEqual({ total: 3, live: 1, buyable: 1 });
  });

  it('counts a DELETED product as gone, not as one fewer target', () => {
    // The stored id list is what the seller chose, so a product that no longer exists has to
    // read as "1 of 3 lost" — measuring `total` off the surviving rows would report 2 of 2 and
    // the card would say nothing is wrong.
    expect(campaignHealth(c, [product('p1'), product('p2')], CATEGORIES)).toEqual({ total: 3, live: 2, buyable: 2 });
  });

  it('starves only when nothing is left', () => {
    const allGone = [product('p1', { blocked: true }), product('p2', { hidden: true })];
    expect(isCampaignStarved(campaignHealth(c, allGone, CATEGORIES))).toBe(true);
    expect(isCampaignStarved(campaignHealth(c, [product('p1')], CATEGORIES))).toBe(false);
  });

  it('reads a legacy single-product row through its flat productId', () => {
    const legacy = campaign({ scope: 'product', productId: 'p9', productName: 'old' });
    expect(campaignHealth(legacy, [product('p9', { blocked: true })], CATEGORIES)).toEqual({ total: 1, live: 0, buyable: 0 });
  });

  // `live` is about the listing, `buyable` about the shelf — a sold-out product is still ON the
  // storefront, which is what keeps the two pauses (permanent vs temporary) apart.
  it('counts a sold-out product as live but not buyable', () => {
    const health = campaignHealth(c, [product('p1', { stock: 0 }), product('p2'), product('p3')], CATEGORIES);
    expect(health).toEqual({ total: 3, live: 3, buyable: 2 });
  });
});

describe('campaignHealth — categories and whole store', () => {
  it('covers a picked category AND everything beneath it', () => {
    const c = campaign({ scope: 'categories', categoryIds: ['c-shoes'], categoryNames: ['נעליים'] });
    const products = [product('p1', { categoryId: 'c-shoes' }), product('p2', { categoryId: 'c-sport' }), product('p3', { categoryId: 'c-bags' })];
    expect(campaignHealth(c, products, CATEGORIES)).toEqual({ total: 2, live: 2, buyable: 2 });
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

  it('says nothing at all when nothing is wrong', () => {
    expect(campaignHealthNote({ total: 3, live: 3, buyable: 3 }, undefined, L)).toBe('');
    expect(campaignHealthNote(undefined, undefined, L)).toBe('');
  });
});

/** The functions above only DECIDE. `getCampaignsForStore` is what acts on the decision, and it is
 *  the half that carries risk: it WRITES during a read, on a JSON file every dashboard load and
 *  every 15s poll touches. Two properties have to hold or that write is a liability — it must fire
 *  only when a campaign actually needs pausing, and it must not fire again once it has. */
const STORED: AdCampaign[] = [];
const PRODUCTS: StoreProduct[] = [];
const writes: Array<{ id: string; storeId: string; updates: Partial<AdCampaign> }> = [];
const STORE = { id: 's1', slug: 's', blocked: false } as { id: string; slug: string; blocked: boolean };

// ONE registration per module for the whole file: vi.doMock replaces any earlier factory for the
// same id, so a second suite declaring its own would silently un-mock the first one's fixture.
vi.doMock('../src/lib/ad-campaigns.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/ad-campaigns.js')>();
  return {
    ...actual,
    // Mirrors the real accessors' split: the live list excludes history, and archiving is a
    // status change on the row rather than a removal. A fixture that returned everything would
    // let a test pass while the real dashboard showed cancelled campaigns among the running ones.
    getCampaignsByStoreId: (storeId: string) => STORED.filter((c) => c.storeId === storeId && !c.archivedAt),
    getArchivedByStoreId: (storeId: string) => STORED.filter((c) => c.storeId === storeId && !!c.archivedAt),
    archiveCampaign: (id: string, storeId: string) => {
      const row = STORED.find((c) => c.id === id && c.storeId === storeId);
      if (!row || row.archivedAt) return row;
      Object.assign(row, { status: 'paused', archivedAt: '2026-07-30T00:00:00.000Z', pausedAt: row.pausedAt ?? '2026-07-30T00:00:00.000Z' });
      return row;
    },
    updateCampaign: (id: string, storeId: string, u: Partial<AdCampaign>) => {
      writes.push({ id, storeId, updates: u });
      const row = STORED.find((c) => c.id === id && c.storeId === storeId);
      if (!row) return undefined;
      Object.assign(row, u);
      // Mirrors the real updateCampaign's own transition contract — resuming clears both the
      // pause moment and its reason. A mock that skipped this would let the auto-resume test
      // pass while the campaign kept carrying "paused because sold out" forever.
      if (u.status === 'active') { delete row.pausedAt; delete row.pausedReason; }
      return { ...row };
    },
  };
});
vi.doMock('../src/lib/store-products.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/store-products.js')>();
  return { ...actual, getProductsByStoreId: (storeId: string) => PRODUCTS.filter((p) => p.storeId === storeId) };
});
vi.doMock('../src/lib/store-categories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/store-categories.js')>();
  return { ...actual, getCategoriesByStoreId: () => CATEGORIES };
});
vi.doMock('../src/lib/stores.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/stores.js')>();
  return { ...actual, getStoreById: (id: string) => (id === 's1' ? STORE : undefined) };
});

beforeEach(() => {
  vi.resetModules();
  STORED.length = 0; PRODUCTS.length = 0; writes.length = 0;
  STORE.blocked = false;
});

describe('getCampaignsForStore — the automatic pause', () => {
  const load = async (): Promise<ReturnType<typeof import('../src/lib/ad-campaign-health.js').getCampaignsForStore>> => {
    const mod = await import('../src/lib/ad-campaign-health.js');
    return mod.getCampaignsForStore('s1');
  };

  it('pauses a campaign with nothing left, and records that the platform did it', async () => {
    STORED.push(campaign({ id: 'dead', scope: 'products', productIds: ['gone'] }));
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(writes).toEqual([{ id: 'dead', storeId: 's1', updates: { status: 'paused', pausedReason: 'unavailable' } }]);
  });

  it('writes NOTHING when the campaign is healthy — a dashboard load is a read', async () => {
    PRODUCTS.push(product('p1'));
    STORED.push(campaign({ id: 'ok', scope: 'products', productIds: ['p1'] }));
    expect((await load())[0]?.status).toBe('active');
    expect(writes).toEqual([]);
  });

  // Without this the poll would rewrite the whole campaigns file every 15 seconds, forever, for a
  // campaign that is already paused — on JSON that is a full read-modify-write each time.
  it('does not re-pause what it already paused', async () => {
    STORED.push(campaign({ id: 'dead', status: 'paused', pausedReason: 'unavailable', scope: 'products', productIds: ['gone'] }));
    expect((await load())[0]?.status).toBe('paused');
    expect(writes).toEqual([]);
  });

  it('leaves a campaign that is still partly alive running, rather than narrowing it', async () => {
    PRODUCTS.push(product('p1'), product('p2', { hidden: true }));
    STORED.push(campaign({ id: 'partial', scope: 'products', productIds: ['p1', 'p2'] }));
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.health).toEqual({ total: 2, live: 1, buyable: 1 });
    expect(writes).toEqual([]);
  });

  it('never reads or writes another store\'s campaigns', async () => {
    STORED.push(campaign({ id: 'theirs', storeId: 's2', scope: 'products', productIds: ['gone'] }));
    expect(await load()).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe('resumeBlockReason', () => {
  // The guard both routes call. It is what stops an automatic pause from being undone by one
  // click, so it is tested here rather than through either route.
  const blockedFor = async (id: string): Promise<string | null> => {
    const mod = await import('../src/lib/ad-campaign-health.js');
    return mod.resumeBlockReason('s1', id);
  };

  it('refuses while nothing it advertises is on the storefront', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    PRODUCTS.push(product('p1', { hidden: true }));
    expect(await blockedFor('c1')).toBe('unavailable');
  });

  it('refuses while everything in it is sold out, and says so distinctly', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    PRODUCTS.push(product('p1', { stock: 0 }));
    expect(await blockedFor('c1')).toBe('out-of-stock');
  });

  it('allows it once the product is back on the shelf and in stock', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    PRODUCTS.push(product('p1'));
    expect(await blockedFor('c1')).toBeNull();
  });

  it('passes an unknown id through, so the update reports the real error', async () => {
    expect(await blockedFor('nope')).toBeNull();
  });
});

/** The stock half, which is the one that undoes itself. */
describe('getCampaignsForStore — sold out', () => {
  const load = async (): Promise<ReturnType<typeof import('../src/lib/ad-campaign-health.js').getCampaignsForStore>> => {
    const mod = await import('../src/lib/ad-campaign-health.js');
    return mod.getCampaignsForStore('s1');
  };

  it('pauses a campaign whose products are all sold out, marked as the temporary kind', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    PRODUCTS.push(product('p1', { stock: 0 }));
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('out-of-stock');
  });

  it('starts it again BY ITSELF once stock returns', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'out-of-stock' }));
    PRODUCTS.push(product('p1', { stock: 3 }));
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.pausedReason).toBeUndefined();
  });

  // The whole point of telling the two pauses apart: a seller who pressed pause, or a product a
  // human took off the shelf, must NOT be overridden by a stock delivery.
  it('never resumes a campaign the seller paused himself', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused' }));
    PRODUCTS.push(product('p1', { stock: 3 }));
    expect((await load())[0]?.status).toBe('paused');
    expect(writes).toEqual([]);
  });

  it('never resumes one the platform stopped for being off the storefront', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    PRODUCTS.push(product('p1', { stock: 3 }));
    expect((await load())[0]?.status).toBe('paused');
  });

  it('keeps a partly-sold-out campaign running on what is left', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1', 'p2'] }));
    PRODUCTS.push(product('p1', { stock: 0 }), product('p2', { stock: 4 }));
    const [row] = await load();
    expect(row?.status).toBe('active');
    expect(row?.health).toEqual({ total: 2, live: 2, buyable: 1 });
  });

  // 'out-of-stock' is a promise the card makes ("it comes back by itself"). Once the product
  // leaves the storefront that promise is false, so the stored reason has to follow.
  it('upgrades a stock pause to a permanent one when the product then leaves the shelf', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'out-of-stock' }));
    PRODUCTS.push(product('p1', { stock: 0, hidden: true }));
    expect((await load())[0]?.pausedReason).toBe('unavailable');
  });

  // ...and never the other way: a stop a human caused stays his to undo, even when the current
  // symptom is the milder one.
  it('never downgrades a permanent pause into a self-healing one', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    PRODUCTS.push(product('p1', { stock: 0 }));
    const [row] = await load();
    expect(row?.pausedReason).toBe('unavailable');
    expect(row?.status).toBe('paused');
  });

  it('reports being off the shelf, not merely sold out, when it is both', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    PRODUCTS.push(product('p1', { stock: 0, hidden: true }));
    expect((await load())[0]?.pausedReason).toBe('unavailable');
  });
});

/** Cancelling and finishing — the half that decides whether a campaign's spend survives it. */
describe('history: cancelled and finished campaigns', () => {
  const load = async (): Promise<ReturnType<typeof import('../src/lib/ad-campaign-health.js').getCampaignsForStore>> => {
    const mod = await import('../src/lib/ad-campaign-health.js');
    return mod.getCampaignsForStore('s1');
  };
  const history = async (): Promise<ReturnType<typeof import('../src/lib/ad-campaign-health.js').getCampaignHistory>> => {
    const mod = await import('../src/lib/ad-campaign-health.js');
    return mod.getCampaignHistory('s1');
  };
  const blockedFor = async (id: string): Promise<string | null> => {
    const mod = await import('../src/lib/ad-campaign-health.js');
    return mod.resumeBlockReason('s1', id);
  };

  // A fixed-duration campaign from last month: its own end date is in the past.
  const finished = (extra: Partial<AdCampaign> = {}): AdCampaign =>
    campaign({ id: 'old', durationDays: 7, createdAt: '2026-01-01T00:00:00.000Z', ...extra });

  it('moves a campaign that ran its course into history, by itself', async () => {
    STORED.push(finished({ scope: 'products', productIds: ['p1'] }));
    PRODUCTS.push(product('p1'));
    expect(await load()).toEqual([]);        // gone from "your campaigns"
    expect(STORED[0]?.archivedAt).toBeTruthy(); // but still on record
  });

  it('never resumes a finished campaign — that budget was for a period that is over', async () => {
    STORED.push(finished({ status: 'paused', scope: 'products', productIds: ['p1'] }));
    PRODUCTS.push(product('p1'));
    expect(await blockedFor('old')).toBe('ended');
  });

  it('leaves an ONGOING campaign alone however old it is', async () => {
    STORED.push(campaign({ id: 'ongoing', createdAt: '2026-01-01T00:00:00.000Z', scope: 'products', productIds: ['p1'] }));
    PRODUCTS.push(product('p1'));
    expect((await load()).map((c) => c.id)).toEqual(['ongoing']);
  });

  it('keeps history out of the live list and the live list out of history', async () => {
    STORED.push(
      campaign({ id: 'live', scope: 'products', productIds: ['p1'] }),
      campaign({ id: 'cancelled', status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z', scope: 'products', productIds: ['p1'] }),
    );
    PRODUCTS.push(product('p1'));
    expect((await load()).map((c) => c.id)).toEqual(['live']);
    expect((await history()).map((c) => c.id)).toEqual(['cancelled']);
  });

  // The reason the row is kept at all: every reported figure is derived from the campaign list,
  // so a cancelled campaign that has left the dashboard must still be there to be summed.
  it('a cancelled campaign is still a campaign for anything that counts money', async () => {
    STORED.push(campaign({ id: 'cancelled', status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z' }));
    expect((await history()).map((c) => c.id)).toEqual(['cancelled']);
  });

  it('refuses to resume anything that is already in history', async () => {
    STORED.push(campaign({ id: 'cancelled', status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z' }));
    expect(await blockedFor('cancelled')).toBe('ended');
  });

  // The block is a display surface, not the ledger: it caps what it draws, while the rows behind
  // it stay whole for anything that sums money.
  it('caps how many past campaigns it draws, without dropping the rows', async () => {
    const { CAMPAIGN_HISTORY_LIMIT } = await import('../src/lib/ad-campaign-health.js');
    for (let n = 0; n < CAMPAIGN_HISTORY_LIMIT + 5; n++) {
      STORED.push(campaign({ id: `old-${n}`, status: 'paused', archivedAt: '2026-07-20T10:00:00.000Z' }));
    }
    expect((await history()).length).toBe(CAMPAIGN_HISTORY_LIMIT);
    expect(STORED.length).toBe(CAMPAIGN_HISTORY_LIMIT + 5);
  });

  // A blocked store 404s on every page it has, so each of its campaigns is buying clicks to a
  // dead end — however healthy the individual product rows still look.
  it('stops every campaign of a store the admin blocked', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'] }));
    PRODUCTS.push(product('p1'));
    STORE.blocked = true;
    const [row] = await load();
    expect(row?.status).toBe('paused');
    expect(row?.pausedReason).toBe('unavailable');
    expect(row?.health).toEqual({ total: 1, live: 0, buyable: 0 });
  });

  it('lets them run again once the block is lifted — but only when a human says so', async () => {
    STORED.push(campaign({ id: 'c1', scope: 'products', productIds: ['p1'], status: 'paused', pausedReason: 'unavailable' }));
    PRODUCTS.push(product('p1'));
    const [row] = await load();
    expect(row?.status).toBe('paused');            // not resumed for him
    const mod = await import('../src/lib/ad-campaign-health.js');
    expect(mod.resumeBlockReason('s1', 'c1')).toBeNull(); // but the button now works
  });
});
