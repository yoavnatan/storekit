import { describe, expect, it } from 'vitest';
import { isStoreIncomplete, filterAndSortSellerCards, filterAndSortStoreRows, type SellerCardData, type StoreRow } from '../src/lib/admin-stats.js';
import type { Store } from '../src/lib/stores.js';
import type { Seller } from '../src/lib/seller-auth.js';

function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    id: 's1',
    sellerId: 'seller1',
    slug: 'my-store',
    name: 'My Store',
    tagline: '',
    description: '',
    colors: { primary: '#000', accent: '#000' },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isStoreIncomplete', () => {
  // Shipping is now platform-provided (no per-store shipping config to be "missing"),
  // so incompleteness is driven solely by whether the store has any products.
  it('is complete when it has products', () => {
    const store = makeStore();
    expect(isStoreIncomplete(store, 5)).toBe(false);
  });

  it('is incomplete when it has zero products', () => {
    const store = makeStore();
    expect(isStoreIncomplete(store, 0)).toBe(true);
  });
});

function makeSeller(overrides: Partial<Seller> = {}): Seller {
  return { id: 'seller1', name: 'Seller', email: 'seller@example.com', passwordHash: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function makeSellerCard(overrides: Partial<SellerCardData> = {}, storeOverrides: Partial<Store> = {}): SellerCardData {
  const seller = makeSeller(overrides.seller);
  return {
    seller,
    stores: [{ store: makeStore({ sellerId: seller.id, ...storeOverrides }), products: [], revenue: { totalRevenue: 0, monthRevenue: 0 } }],
    totalProducts: 0,
    revenue: { totalRevenue: 0, monthRevenue: 0 },
    ...overrides,
  };
}

describe('filterAndSortSellerCards', () => {
  it('sorts by join date, newest first, by default', () => {
    const cards = [
      makeSellerCard({ seller: makeSeller({ id: 's1', createdAt: '2026-01-01T00:00:00.000Z' }) }),
      makeSellerCard({ seller: makeSeller({ id: 's2', createdAt: '2026-01-05T00:00:00.000Z' }) }),
    ];
    const result = filterAndSortSellerCards(cards, { q: '', sortCol: 'joined', sortDir: 'desc', blockedOnly: false });
    expect(result.map((c) => c.seller.id)).toEqual(['s2', 's1']);
  });

  it('sorts by revenue when requested', () => {
    const cards = [
      makeSellerCard({ seller: makeSeller({ id: 's1' }), revenue: { totalRevenue: 50, monthRevenue: 0 } }),
      makeSellerCard({ seller: makeSeller({ id: 's2' }), revenue: { totalRevenue: 200, monthRevenue: 0 } }),
    ];
    const result = filterAndSortSellerCards(cards, { q: '', sortCol: 'revenue', sortDir: 'desc', blockedOnly: false });
    expect(result.map((c) => c.seller.id)).toEqual(['s2', 's1']);
  });

  it('filters to only sellers with a blocked store when blockedOnly is set', () => {
    const cards = [
      makeSellerCard({ seller: makeSeller({ id: 's1' }) }, { blocked: true }),
      makeSellerCard({ seller: makeSeller({ id: 's2' }) }, { blocked: false }),
    ];
    const result = filterAndSortSellerCards(cards, { q: '', sortCol: 'joined', sortDir: 'desc', blockedOnly: true });
    expect(result.map((c) => c.seller.id)).toEqual(['s1']);
  });
});

function makeStoreRow(overrides: Partial<StoreRow> = {}): StoreRow {
  return {
    store: makeStore(),
    seller: undefined,
    productCount: 0,
    revenue: { totalRevenue: 0, monthRevenue: 0 },
    ...overrides,
  };
}

describe('filterAndSortStoreRows', () => {
  it('sorts by name ascending by default', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ name: 'ב חנות' }) }),
      makeStoreRow({ store: makeStore({ name: 'א חנות' }) }),
    ];
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'name', sortDir: 'asc', blockedOnly: false });
    expect(result.map((r) => r.store.name)).toEqual(['א חנות', 'ב חנות']);
  });

  it('sorts by product count when requested', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ id: 's1' }), productCount: 2 }),
      makeStoreRow({ store: makeStore({ id: 's2' }), productCount: 10 }),
    ];
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'products', sortDir: 'desc', blockedOnly: false });
    expect(result.map((r) => r.store.id)).toEqual(['s2', 's1']);
  });

  it('filters to only blocked stores when blockedOnly is set', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ id: 's1', blocked: true }) }),
      makeStoreRow({ store: makeStore({ id: 's2', blocked: false }) }),
    ];
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'name', sortDir: 'asc', blockedOnly: true });
    expect(result.map((r) => r.store.id)).toEqual(['s1']);
  });
});
