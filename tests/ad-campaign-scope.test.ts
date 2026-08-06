import { describe, expect, it, vi } from 'vitest';
import { campaignScopeName, campaignTargetingLabel } from '../src/lib/ad-scope-label.js';
import type { StoreProduct } from '../src/lib/store-products.js';
import type { StoreCategory } from '../src/lib/store-categories.js';

/** A boost may name the whole store, several hand-picked products, or several categories. What
 *  a campaign is ALLOWED to name is a spending decision, so these cover the seam where an
 *  untrusted body becomes a stored campaign: ownership, the caps, the single-product shape that
 *  every pre-existing reader still understands, and the wording all three surfaces share.
 */

// `stock: 5` unless a row says otherwise — the create path only accepts a product that is on the
// storefront AND in stock, so both of those have to be expressible here.
const PRODUCTS = [
  { id: 'p1', storeId: 's1', name: 'נעל ריצה' },
  { id: 'p-hidden', storeId: 's1', name: 'ירד מהמדף', hidden: true },
  { id: 'p-empty', storeId: 's1', name: 'אזל מהמלאי', stock: 0 },
  { id: 'p2', storeId: 's1', name: 'גרביים' },
  { id: 'p3', storeId: 's1', name: 'כובע' },
  { id: 'p-other', storeId: 's2', name: 'של מוכר אחר' },
  ...Array.from({ length: 60 }, (_, n) => ({ id: `p-x${n}`, storeId: 's1', name: `X${n}` })),
].map((p) => ({ stock: 5, ...p })) as unknown as StoreProduct[];

const CATEGORIES: StoreCategory[] = [
  { id: 'c-shoes', storeId: 's1', name: 'נעליים', parentId: null, order: 0, createdAt: '2026-07-01' },
  { id: 'c-hats', storeId: 's1', name: 'כובעים', parentId: null, order: 1, createdAt: '2026-07-01' },
  { id: 'c-other', storeId: 's2', name: 'של מוכר אחר', parentId: null, order: 0, createdAt: '2026-07-01' },
  ...Array.from({ length: 12 }, (_, n) => ({ id: `c-x${n}`, storeId: 's1', name: `C${n}`, parentId: null, order: 10 + n, createdAt: '2026-07-01' })),
];

vi.mock('../src/lib/store-products.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/store-products.js')>();
  return { ...actual, getProductsByStoreId: (storeId: string) => PRODUCTS.filter((p) => p.storeId === storeId) };
});

vi.mock('../src/lib/store-categories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/store-categories.js')>();
  return { ...actual, getCategoriesByStoreId: (storeId: string) => CATEGORIES.filter((c) => c.storeId === storeId) };
});

const { buildCampaignInput, MAX_CAMPAIGN_PRODUCTS, MAX_CAMPAIGN_CATEGORIES, MIN_CAMPAIGN_BUDGET, MAX_CAMPAIGN_BUDGET,
  isValidCampaignBudget, AD_BUDGET_PRESETS } = await import('../src/lib/ad-campaign-input.js');

const STORE = { id: 's1', slug: 'my-store' };
const base = { platform: 'both', monthlyBudget: 200 };

describe('buildCampaignInput — product scope', () => {
  it('keeps several products, named in the seller\'s pick order', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: ['p3', 'p1'] }, STORE));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.scope).toBe('products');
    expect(built.input.productIds).toEqual(['p3', 'p1']);
    expect(built.input.productNames).toEqual(['כובע', 'נעל ריצה']);
  });

  it('collapses ONE product back to the flat single-product shape a pre-existing reader knows', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: ['p2'] }, STORE));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.scope).toBe('product');
    expect(built.input.productId).toBe('p2');
    expect(built.input.productName).toBe('גרביים');
    expect(built.input.productIds).toBeUndefined();
  });

  it('still accepts the admin form\'s single `productId` string', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'product', productId: 'p1' }, STORE));
    expect(built.ok && built.input.productId).toBe('p1');
  });

  it('drops a product belonging to another seller instead of advertising it', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: ['p1', 'p-other', 'nope'] }, STORE));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // One survivor → the single-product shape, and the foreign id is simply not there.
    expect(built.input.scope).toBe('product');
    expect(built.input.productId).toBe('p1');
  });

  // What the picker shows is what the server accepts. A stale page or a hand-built POST would
  // otherwise buy clicks to a page that 404s, or to one that says "sold out".
  it('refuses a product that is off the storefront, or out of stock', async () => {
    expect((await buildCampaignInput({ ...base, scope: 'products', productIds: ['p-hidden'] }, STORE)))
      .toMatchObject({ ok: false, status: 409, error: 'PRODUCT_NOT_ADVERTISABLE' });
    expect((await buildCampaignInput({ ...base, scope: 'products', productIds: ['p-empty'] }, STORE)))
      .toMatchObject({ ok: false, status: 409, error: 'PRODUCT_NOT_ADVERTISABLE' });
  });

  it('keeps the advertisable ones when only some of the pick is unusable', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: ['p1', 'p-empty', 'p2'] }, STORE));
    expect(built.ok && built.input.productIds).toEqual(['p1', 'p2']);
  });

  it('rejects a pick made ENTIRELY of ids this store does not own', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: ['p-other'] }, STORE));
    expect(built).toMatchObject({ ok: false, status: 409 });
  });

  it('rejects an empty pick rather than silently widening to the whole store', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: [] }, STORE));
    expect(built).toMatchObject({ ok: false, status: 400 });
  });

  it('caps how many products one campaign may name', async () => {
    const ids = Array.from({ length: MAX_CAMPAIGN_PRODUCTS + 1 }, (_, n) => `p-x${n}`);
    expect((await buildCampaignInput({ ...base, scope: 'products', productIds: ids }, STORE)).ok).toBe(false);
  });

  it('de-duplicates a repeated id so the cap counts real picks', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'products', productIds: ['p1', 'p1', 'p2'] }, STORE));
    expect(built.ok && built.input.productIds).toEqual(['p1', 'p2']);
  });

  // A hand-built POST controls this array's length. The rejection alone isn't the point — it's
  // that rejecting stays cheap: the id pass used to be quadratic (`out.includes` over a
  // request-controlled list) and ran in FULL before the cap was consulted, so 40k ids blocked
  // the single SSR thread for ~5s. Timed, because "it still rejects" would pass either way.
  it('rejects an oversized pick without doing the work, so a huge POST cannot stall SSR', async () => {
    const ids = Array.from({ length: 40_000 }, (_, n) => `flood-${n}`);
    const started = performance.now();
    expect((await buildCampaignInput({ ...base, scope: 'products', productIds: ids }, STORE)).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('buildCampaignInput — category scope', () => {
  it('names the picked categories', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'categories', categoryIds: ['c-hats', 'c-shoes'] }, STORE));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.scope).toBe('categories');
    expect(built.input.categoryIds).toEqual(['c-hats', 'c-shoes']);
    expect(built.input.categoryNames).toEqual(['כובעים', 'נעליים']);
  });

  it('drops another seller\'s category, and rejects a pick made only of those', async () => {
    expect((await buildCampaignInput({ ...base, scope: 'categories', categoryIds: ['c-shoes', 'c-other'] }, STORE)).ok).toBe(true);
    expect((await buildCampaignInput({ ...base, scope: 'categories', categoryIds: ['c-other'] }, STORE))).toMatchObject({ ok: false, status: 404 });
  });

  it('caps how many categories one campaign may name', async () => {
    const ids = Array.from({ length: MAX_CAMPAIGN_CATEGORIES + 1 }, (_, n) => `c-x${n}`);
    expect((await buildCampaignInput({ ...base, scope: 'categories', categoryIds: ids }, STORE)).ok).toBe(false);
  });
});

describe('buildCampaignInput — the rest of the body', () => {
  it('ignores an audience posted with a store-wide campaign (each product self-targets)', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'store', audience: { gender: 'men', age: 'adult' } }, STORE));
    expect(built.ok && built.input.audience).toBeUndefined();
  });

  it('keeps the audience on a narrowed scope — the seller picked that slice himself', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'categories', categoryIds: ['c-shoes'], audience: { gender: 'men', age: 'adult' } }, STORE));
    expect(built.ok && built.input.audience).toEqual({ gender: 'men', age: 'adult' });
  });

  it('rejects an unknown scope, a bad platform and a below-minimum budget', async () => {
    expect((await buildCampaignInput({ ...base, scope: 'everything' }, STORE)).ok).toBe(false);
    expect((await buildCampaignInput({ ...base, platform: 'tiktok', scope: 'store' }, STORE)).ok).toBe(false);
    expect((await buildCampaignInput({ ...base, monthlyBudget: 49, scope: 'store' }, STORE)).ok).toBe(false);
    expect((await buildCampaignInput({ ...base, monthlyBudget: Number.NaN, scope: 'store' }, STORE)).ok).toBe(false);
  });
});

describe('isValidCampaignBudget — one rule for POST, PATCH and both forms', () => {
  it('takes the range and nothing else', () => {
    expect(isValidCampaignBudget(MIN_CAMPAIGN_BUDGET)).toBe(true);
    expect(isValidCampaignBudget(MAX_CAMPAIGN_BUDGET)).toBe(true);
    expect(isValidCampaignBudget(777)).toBe(true); // any amount in range, not a multiple of ten
    expect(isValidCampaignBudget(MIN_CAMPAIGN_BUDGET - 1)).toBe(false);
    expect(isValidCampaignBudget(MAX_CAMPAIGN_BUDGET + 1)).toBe(false);
  });

  // A bare `>= MIN` lets both of these through: every comparison against NaN is false, so
  // `!(x < MIN)` is true for NaN, and Infinity passes any lower bound. The PATCH route used to
  // guard with exactly that shape and no ceiling at all.
  it('rejects NaN, Infinity and non-numbers', () => {
    expect(isValidCampaignBudget(Number.NaN)).toBe(false);
    expect(isValidCampaignBudget(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidCampaignBudget(1e12)).toBe(false);
    expect(isValidCampaignBudget('500')).toBe(false);
    expect(isValidCampaignBudget(null)).toBe(false);
  });

  // Picking "another amount" now hands the seller an EMPTY field (advertising.ts#syncBudgetChoice,
  // CURRENT_TASK.md item 4), which puts an empty string on the wire path for the first time. This
  // pins what an empty field actually becomes at each hop, because the failure is silent at both:
  // parseFloat('') is NaN, and JSON.stringify turns NaN into `null` — so a submit with nothing
  // typed reaches the route as a MISSING budget, not as a zero. Both are rejected; the client
  // guard exists only so the seller gets the range in the message instead of a generic error.
  it('rejects an empty budget field at both hops — parseFloat then JSON', async () => {
    const parsed = parseFloat('');
    expect(Number.isNaN(parsed)).toBe(true);
    expect(isValidCampaignBudget(parsed)).toBe(false);
    const overTheWire = JSON.parse(JSON.stringify({ monthlyBudget: parsed })) as { monthlyBudget: unknown };
    expect(overTheWire.monthlyBudget).toBeNull();
    expect(isValidCampaignBudget(overTheWire.monthlyBudget)).toBe(false);
    expect((await buildCampaignInput({ ...base, scope: 'store', monthlyBudget: overTheWire.monthlyBudget }, STORE)).ok).toBe(false);
  });
});

describe('AD_BUDGET_PRESETS', () => {
  // The ladder is rendered as ready-made options, so a preset the server would refuse is an
  // option that fails the moment it's clicked — the one way these two constants can disagree.
  it('offers only amounts the server accepts, in ascending order', async () => {
    expect(AD_BUDGET_PRESETS.length).toBeGreaterThan(1);
    for (const amount of AD_BUDGET_PRESETS) {
      expect(isValidCampaignBudget(amount)).toBe(true);
      expect((await buildCampaignInput({ ...base, scope: 'store', monthlyBudget: amount }, STORE)).ok).toBe(true);
    }
    expect([...AD_BUDGET_PRESETS]).toEqual([...AD_BUDGET_PRESETS].sort((a, b) => a - b));
  });
});

describe('campaignScopeName / campaignTargetingLabel', () => {
  const L = {
    adScopeStore: 'כל החנות', adScopeAndMore: 'ועוד {n}', adAutoPerProduct: 'אוטומטי',
    adAudienceAll: 'כל הקהל', adGenderMen: 'גברים', adAgeAdult: 'מבוגרים',
    adDuration7: 'שבוע', adDurationOngoing: 'רציף',
  };

  it('names a multi-product campaign and collapses the tail into a count', () => {
    expect(campaignScopeName({ scope: 'products', productNames: ['א', 'ב', 'ג', 'ד'] }, L)).toBe('א, ב ועוד 2');
  });

  it('still labels a legacy row that carries only the flat productName', () => {
    expect(campaignScopeName({ scope: 'product', productName: 'נעל' }, L)).toBe('נעל');
  });

  it('labels category scope by its category names, and store scope by the store line', () => {
    expect(campaignScopeName({ scope: 'categories', categoryNames: ['נעליים'] }, L)).toBe('נעליים');
    expect(campaignScopeName({ scope: 'store' }, L)).toBe('כל החנות');
  });

  it('says "auto per product" only for a store-wide campaign', () => {
    expect(campaignTargetingLabel({ scope: 'store' }, L)).toBe('אוטומטי · רציף');
    expect(campaignTargetingLabel({ scope: 'products', durationDays: 7 }, L)).toBe('כל הקהל · שבוע');
    expect(campaignTargetingLabel({ scope: 'categories', audience: { gender: 'men', age: 'adult' } }, L)).toBe('גברים · מבוגרים · רציף');
  });
});

/** The budget rule is the one field in this form that spends the seller's money, and it lives in
 *  `lib/ad-budget.ts` so the create path, the two PATCH routes and the form's own min/max all read
 *  the same numbers. Both ends are covered here because both were open at some point: there was no
 *  ceiling at all (`isFinite` accepts 1e12, and ad-metrics divides that by 30 into the dashboards),
 *  and each PATCH route carried its own hardcoded floor — so raising the floor here would have left
 *  "create at the floor, then patch back under it" working. */
describe('campaign budget bounds', () => {
  it('accepts the range and rejects either side of it, NaN and Infinity included', () => {
    expect(isValidCampaignBudget(MIN_CAMPAIGN_BUDGET)).toBe(true);
    expect(isValidCampaignBudget(MAX_CAMPAIGN_BUDGET)).toBe(true);
    expect(isValidCampaignBudget(MIN_CAMPAIGN_BUDGET - 1)).toBe(false);
    expect(isValidCampaignBudget(MAX_CAMPAIGN_BUDGET + 1)).toBe(false);
    expect(isValidCampaignBudget(1e12)).toBe(false);
    expect(isValidCampaignBudget(Number.NaN)).toBe(false);
    expect(isValidCampaignBudget(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidCampaignBudget('200')).toBe(false);
  });

  it('refuses to build a campaign above the ceiling', async () => {
    const built = (await buildCampaignInput({ ...base, scope: 'store', monthlyBudget: MAX_CAMPAIGN_BUDGET + 1 }, STORE));
    expect(built.ok).toBe(false);
  });

  // The PATCH routes gate on this same predicate; a route that re-typed the comparison instead is
  // how the two ends drift, so fail if either stops importing it.
  it('is what both campaign routes gate their budget updates on', async () => {
    const fs = await import('node:fs');
    for (const route of ['src/pages/api/seller/ad-campaigns.ts', 'src/pages/api/admin/ad-campaigns.ts']) {
      const src = fs.readFileSync(route, 'utf8');
      expect(src, `${route} must use isValidCampaignBudget`).toContain('isValidCampaignBudget(monthlyBudget)');
      expect(src, `${route} must not re-type the budget floor`).not.toMatch(/monthlyBudget\s*>=\s*\d/);
    }
  });
});

/**
 * A showcase store is never advertised (owner, 2026-08-06, emphatically).
 *
 * Its catalogue is fabricated, and submitting fabricated products to Merchant Center is a policy
 * violation against the ONE ad account every seller on the platform is advertised through — the
 * blast radius is every store at once. The feed has always excluded them (`getIndexableStores`);
 * the gap was that nothing stopped a campaign being created on one, and the health check asked only
 * `canStoreSell`, which a showcase store passes, so such a campaign read perfectly healthy while
 * advertising nothing.
 */
describe('buildCampaignInput — a showcase store may not be advertised', () => {
  const DEMO = { id: 's1', slug: 'my-store', demo: true };

  it('refuses a campaign on a showcase store, whatever the scope', async () => {
    for (const scope of [
      { scope: 'store' },
      { scope: 'products', productIds: ['p1'] },
      { scope: 'categories', categoryIds: ['c1'] },
    ]) {
      const built = await buildCampaignInput({ ...base, ...scope }, DEMO);
      expect(built.ok, JSON.stringify(scope)).toBe(false);
      if (built.ok) return;
      expect(built.error).toBe('CAMPAIGN_DEMO_STORE');
      expect(built.status).toBe(400);
    }
  });

  it('refuses BEFORE anything else, so the reason is never masked by another complaint', async () => {
    // A demo store with an invalid budget must still be told the real reason: fixing the budget
    // would not make the campaign legal, and reporting the budget first sends him to fix the wrong
    // thing.
    const built = await buildCampaignInput({ platform: 'both', monthlyBudget: -5, scope: 'store' }, DEMO);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toBe('CAMPAIGN_DEMO_STORE');
  });

  it('leaves a real store alone', async () => {
    expect((await buildCampaignInput({ ...base, scope: 'store' }, STORE)).ok).toBe(true);
    expect((await buildCampaignInput({ ...base, scope: 'store' }, { ...STORE, demo: false })).ok).toBe(true);
  });

  // Both routes hand their store straight to buildCampaignInput, which is the only reason one check
  // covers the admin path too — and the admin path is exactly how a showcase store's campaign would
  // be created, since it reaches ANY store by slug.
  it('is reached by both routes rather than re-typed in either', async () => {
    const fs = await import('node:fs');
    for (const route of ['src/pages/api/seller/ad-campaigns.ts', 'src/pages/api/admin/ad-campaigns.ts']) {
      const src = fs.readFileSync(route, 'utf8');
      expect(src, `${route} must build its input through the shared gate`).toContain('buildCampaignInput(body, store)');
      expect(src, `${route} must not re-type the demo-store rule`).not.toMatch(/isDemoStore|\.demo\s*===?/);
    }
  });
});
