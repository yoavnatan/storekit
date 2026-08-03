import { describe, it, expect } from 'vitest';
import { buildPlatformAdOverview } from '../src/lib/admin-ads.js';
import { buildHomeFeed, type FeedStore } from '../src/lib/home-feed.js';
import type { Store } from '../src/lib/stores.js';
import type { AdCampaign } from '../src/lib/ad-campaigns.js';
import type { BrandCampaign } from '../src/lib/brand-campaigns.js';

// The two counters are a COUNT/SUM over the whole table now (§3), so the panel takes them as an
// input rather than counting a list that a date range may have narrowed. `campaignTotalsOf` is the
// pure twin of that query — here the list IS the whole table, so it is the same answer.
import { campaignTotalsOf } from '../src/lib/ad-campaigns.js';
const totals = (campaigns: unknown[] = [], brandCampaigns: unknown[] = []) => ({
  campaignTotals: campaignTotalsOf(campaigns as never),
  brandTotals: campaignTotalsOf(brandCampaigns as never),
});

function makeStore(over: Partial<Store> = {}): Store {
  return {
    id: over.id ?? 'store-' + (over.slug ?? 'x'),
    sellerId: 'seller-1',
    slug: over.slug ?? 'store-x',
    name: over.name ?? 'Store X',
    tagline: '',
    description: '',
    colors: { primary: '#000', accent: '#111' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeCampaign(over: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: over.id ?? 'c-1',
    storeId: 'store-x',
    storeSlug: 'store-x',
    scope: 'store',
    platform: 'google',
    monthlyBudgetAgorot: 30000,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeBrand(over: Partial<BrandCampaign> = {}): BrandCampaign {
  return {
    id: over.id ?? 'b-1',
    objective: 'buyers',
    headline: 'Open a store',
    body: 'Join us',
    destinationUrl: '/',
    platform: 'google',
    monthlyBudgetAgorot: 60000,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('buildPlatformAdOverview', () => {
  it('reports connection status from config + feed counts from input', () => {
    const o = buildPlatformAdOverview({
      feedStores: [makeStore({ slug: 'a' }), makeStore({ slug: 'b' })],
      feedProductCount: 12,
      allStores: [],
      campaigns: [], brandCampaigns: [], ...totals(),
      ads: { googleTagId: 'GTM-123', metaPixelId: '' },
      settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(o.connection.googleTag).toBe(true);
    expect(o.connection.metaPixel).toBe(false);
    expect(o.connection.feedStores).toBe(2);
    expect(o.connection.feedProducts).toBe(12);
  });

  it('treats missing ads config as fully unconnected', () => {
    const o = buildPlatformAdOverview({
      feedStores: [], feedProductCount: 0, allStores: [], campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(o.connection.googleTag).toBe(false);
    expect(o.connection.metaPixel).toBe(false);
  });

  it('caps baseline estimated spend at the lifetime budget and computes used %', () => {
    const stores = [makeStore({ id: 's1' }), makeStore({ id: 's2' })];
    const uncapped = buildPlatformAdOverview({
      feedStores: stores, feedProductCount: 4, allStores: stores, campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    const capped = buildPlatformAdOverview({
      feedStores: stores, feedProductCount: 4, allStores: stores, campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 100 },
    });
    // With a 1₪ cap the spend can't exceed it, and used% is clamped to 100.
    expect(uncapped.baseline.budgetUsedPct).toBe(0); // no budget set → 0
    expect(capped.baseline.estimatedSpend).toBeLessThanOrEqual(1);
    expect(capped.baseline.budgetUsedPct).toBeLessThanOrEqual(100);
  });

  it('zeroes baseline spend + impressions when the campaign is paused', () => {
    const stores = [makeStore({ id: 's1' })];
    const o = buildPlatformAdOverview({
      feedStores: stores, feedProductCount: 1, allStores: stores, campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'paused', lifetimeBudgetAgorot: 50000 },
    });
    expect(o.baseline.status).toBe('paused');
    expect(o.baseline.estimatedSpend).toBe(0);
    expect(o.baseline.impressions).toBe(0);
  });

  it('aggregates only active boost campaigns, keeps a total count', () => {
    const campaigns = [
      makeCampaign({ id: 'a', status: 'active', monthlyBudgetAgorot: 30000 }),
      makeCampaign({ id: 'b', status: 'paused', monthlyBudgetAgorot: 90000 }),
    ];
    const o = buildPlatformAdOverview({
      feedStores: [], feedProductCount: 0, allStores: [], campaigns, brandCampaigns: [], ...totals(campaigns),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(o.boost.activeCampaigns).toBe(1);
    expect(o.boost.totalCampaigns).toBe(2);
    // A paused campaign contributes nothing to the aggregate budget.
    expect(o.boost.monthlyBudget).toBe(300);
  });

  it('computes a blended PPC snapshot with safe zero-division guards', () => {
    // No stores, no campaigns → every derived ratio must be 0, never NaN/Infinity.
    const empty = buildPlatformAdOverview({
      feedStores: [], feedProductCount: 0, allStores: [], campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(empty.ppc).toMatchObject({ spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 });
    for (const v of Object.values(empty.ppc)) expect(Number.isFinite(v)).toBe(true);

    // With baseline traffic, impressions/clicks/CTR must be positive and internally consistent.
    const stores = [makeStore({ id: 's1' }), makeStore({ id: 's2' })];
    const o = buildPlatformAdOverview({
      feedStores: stores, feedProductCount: 4, allStores: stores, campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(o.ppc.impressions).toBeGreaterThan(0);
    expect(o.ppc.clicks).toBeGreaterThan(0);
    expect(o.ppc.clicks).toBeLessThanOrEqual(o.ppc.impressions);
    expect(o.ppc.ctr).toBeGreaterThan(0);
  });

  it('commits only active brand budget, and folds brand spend into the PPC blend', () => {
    const brandCampaigns = [
      makeBrand({ id: 'ba', status: 'active', monthlyBudgetAgorot: 60000 }),
      makeBrand({ id: 'bb', status: 'paused', monthlyBudgetAgorot: 120000 }),
    ];
    const noBrand = buildPlatformAdOverview({
      feedStores: [], feedProductCount: 0, allStores: [], campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    const withBrand = buildPlatformAdOverview({
      feedStores: [], feedProductCount: 0, allStores: [], campaigns: [], brandCampaigns, ...totals([], brandCampaigns),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(withBrand.brand.activeCampaigns).toBe(1);
    expect(withBrand.brand.totalCampaigns).toBe(2);
    // Budget is forward-looking: what is committed NOW, so a paused campaign commits nothing.
    expect(withBrand.brand.monthlyBudget).toBe(600);
    // The active brand campaign must add impressions/spend to the blended PPC total.
    expect(withBrand.ppc.impressions).toBeGreaterThan(noBrand.ppc.impressions);
    expect(withBrand.ppc.spend).toBeGreaterThan(noBrand.ppc.spend);
  });

  // The other half of the same rule, and the one that was wrong: a status that stops FUTURE
  // spend must not retro-erase spend that already happened. Pausing a brand campaign used to
  // drop it out of the window's aggregate entirely, so the platform under-reported its own ad
  // cost for a month that had already been paid for — and the same window answered differently
  // before and after the pause. Asserted for BOTH campaign kinds, because the boost half had
  // the identical bug and only the budget line was ever covered here.
  it('keeps spend a paused campaign already accrued inside the window — boost and brand alike', () => {
    const window = { from: '2026-01-01', to: '2026-01-31' };
    // Ran 1–10 Jan, then paused. runPeriod freezes at pausedAt, so ten days of spend stand.
    const pausedBoost = makeCampaign({
      id: 'ran-then-paused', status: 'paused', monthlyBudgetAgorot: 90000,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-10T00:00:00.000Z',
      pausedAt: '2026-01-10T00:00:00.000Z',
    });
    const pausedBrand = makeBrand({
      id: 'brand-ran-then-paused', status: 'paused', monthlyBudgetAgorot: 120000,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-10T00:00:00.000Z',
      pausedAt: '2026-01-10T00:00:00.000Z',
    });
    const base = {
      feedStores: [], feedProductCount: 0, allStores: [],
      ads: undefined, settings: { baselineStatus: 'paused' as const, lifetimeBudgetAgorot: 0 },
      range: window,
    };
    const o = buildPlatformAdOverview({ ...base, campaigns: [pausedBoost], brandCampaigns: [pausedBrand], ...totals([pausedBoost], [pausedBrand]) });

    expect(o.boost.estimatedSpend).toBeGreaterThan(0);
    expect(o.boost.impressions).toBeGreaterThan(0);
    expect(o.brand.estimatedSpend).toBeGreaterThan(0);
    expect(o.brand.impressions).toBeGreaterThan(0);
    // …while nothing is committed going forward, since neither is running.
    expect(o.boost.activeCampaigns).toBe(0);
    expect(o.boost.monthlyBudget).toBe(0);
    expect(o.brand.activeCampaigns).toBe(0);
    expect(o.brand.monthlyBudget).toBe(0);

    // And the figure does not move when the window is asked again after the pause: the same
    // ten days are reported whether the campaign is still listed as active or not.
    const stillActive = buildPlatformAdOverview({
      ...base,
      campaigns: [{ ...pausedBoost, status: 'active', pausedAt: undefined }],
      brandCampaigns: [],
      ...totals([{ ...pausedBoost, status: 'active' }]),
    });
    expect(stillActive.boost.estimatedSpend).toBeGreaterThanOrEqual(o.boost.estimatedSpend);

    // The reported window is bounded by pausedAt, NOT by updatedAt — so editing a stopped
    // campaign later (correcting its budget, say) cannot retroactively bill the platform for the
    // weeks between. Both kinds must hold; brand carried no pausedAt at all until this fix, so
    // its whole run period stretched to the day of any such edit.
    const editedLater = buildPlatformAdOverview({
      ...base,
      campaigns: [{ ...pausedBoost, updatedAt: '2026-01-31T00:00:00.000Z' }],
      brandCampaigns: [{ ...pausedBrand, updatedAt: '2026-01-31T00:00:00.000Z' }],
      ...totals([pausedBoost], [pausedBrand]),
    });
    expect(editedLater.boost.estimatedSpend).toBe(o.boost.estimatedSpend);
    expect(editedLater.brand.estimatedSpend).toBe(o.brand.estimatedSpend);
  });

  it('caps per-store exposure at a top-N list, keeps the full store count (scalability)', () => {
    const stores = Array.from({ length: 15 }, (_, i) => makeStore({ id: `s${i}`, slug: `s${i}`, name: `Store ${i}` }));
    const o = buildPlatformAdOverview({
      feedStores: stores, feedProductCount: 15, allStores: stores, campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(o.exposure.topStores.length).toBeLessThanOrEqual(10); // never all 15
    expect(o.exposure.totalStores).toBe(15);
    // Sorted by exposure descending.
    for (let i = 1; i < o.exposure.topStores.length; i++) {
      expect(o.exposure.topStores[i - 1]!.impressions).toBeGreaterThanOrEqual(o.exposure.topStores[i]!.impressions);
    }
  });

  it('exposure total impressions equal the three per-source impressions summed', () => {
    const stores = [makeStore({ id: 's1' })];
    const o = buildPlatformAdOverview({
      feedStores: stores, feedProductCount: 1, allStores: stores,
      campaigns: [makeCampaign({ id: 'c', status: 'active' })],
      brandCampaigns: [makeBrand({ id: 'b', status: 'active' })],
      ...totals([makeCampaign({ id: 'c', status: 'active' })], [makeBrand({ id: 'b', status: 'active' })]),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    const { baseline, brand, boost } = o.exposure.bySource;
    expect(o.exposure.totalImpressions).toBe(baseline.impressions + brand.impressions + boost.impressions);
    expect(o.exposure.totalSpend).toBe(baseline.spend + brand.spend + boost.spend);
  });

  it('lists promoted stores highest-weight first, excludes unpromoted', () => {
    const allStores = [
      makeStore({ slug: 'plain', name: 'Plain' }),
      makeStore({ slug: 'boosted', name: 'Boosted', promoWeight: 1 }),
      makeStore({ slug: 'top', name: 'Top', promoWeight: 2 }),
    ];
    const o = buildPlatformAdOverview({
      feedStores: allStores, feedProductCount: 3, allStores, campaigns: [], brandCampaigns: [], ...totals(),
      ads: undefined, settings: { baselineStatus: 'active', lifetimeBudgetAgorot: 0 },
    });
    expect(o.promotedStores.map((s) => s.slug)).toEqual(['top', 'boosted']);
    expect(o.promotedStores[0]!.weight).toBe(2);
  });
});

describe('home-feed promotion (silent shop-window)', () => {
  const fs = (slug: string, promoWeight?: number): FeedStore => ({
    store: makeStore({ id: slug, slug, name: slug, promoWeight }),
    previewImages: [],
  });

  it('floats promoted stores to the front of the spotlight, above unpromoted', () => {
    const stores = [fs('a'), fs('b'), fs('c'), fs('promoted', 2), fs('d')];
    const feed = buildHomeFeed(stores);
    // The promoted store must appear before every unpromoted one in the spotlight.
    const idx = feed.spotlight.findIndex((f) => f.store.slug === 'promoted');
    expect(idx).toBe(0);
  });

  it('leaves ordering unchanged when nothing is promoted (stable)', () => {
    const stores = [fs('a'), fs('b'), fs('c')];
    const feedA = buildHomeFeed(stores).spotlight.map((f) => f.store.slug);
    const feedB = buildHomeFeed(stores).spotlight.map((f) => f.store.slug);
    // Deterministic within the same daily seed — same order both times.
    expect(feedA).toEqual(feedB);
  });
});
