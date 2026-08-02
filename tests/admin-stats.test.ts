import { describe, expect, it } from 'vitest';
import { isStoreIncomplete, filterAndSortSellerCards, filterAndSortStoreRows, countStoreStates, parseStoreQuery, type SellerCardData, type StoreRow, type StoreStateFilter } from '../src/lib/admin-stats.js';

/** A fixed instant for the lifecycle timestamps — their value never matters, only their presence. */
const NOW = '2026-07-31T10:00:00.000Z';
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
    stores: [{ store: makeStore({ sellerId: seller.id, ...storeOverrides }), products: [], revenue: { totalRevenueAgorot: 0, monthRevenueAgorot: 0 } }],
    totalProducts: 0,
    revenue: { totalRevenueAgorot: 0, monthRevenueAgorot: 0 },
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
      makeSellerCard({ seller: makeSeller({ id: 's1' }), revenue: { totalRevenueAgorot: 50, monthRevenueAgorot: 0 } }),
      makeSellerCard({ seller: makeSeller({ id: 's2' }), revenue: { totalRevenueAgorot: 200, monthRevenueAgorot: 0 } }),
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
    revenue: { totalRevenueAgorot: 0, monthRevenueAgorot: 0 },
    openOrders: 0,
    ...overrides,
  };
}

describe('filterAndSortStoreRows', () => {
  it('sorts by name ascending by default', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ name: 'ב חנות' }) }),
      makeStoreRow({ store: makeStore({ name: 'א חנות' }) }),
    ];
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'name', sortDir: 'asc', state: 'all' });
    expect(result.map((r) => r.store.name)).toEqual(['א חנות', 'ב חנות']);
  });

  it('sorts by product count when requested', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ id: 's1' }), productCount: 2 }),
      makeStoreRow({ store: makeStore({ id: 's2' }), productCount: 10 }),
    ];
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'products', sortDir: 'desc', state: 'all' });
    expect(result.map((r) => r.store.id)).toEqual(['s2', 's1']);
  });

  it('filters to one lifecycle state at a time', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ id: 'blocked', blocked: true }) }),
      makeStoreRow({ store: makeStore({ id: 'paused', pausedAt: NOW }) }),
      makeStoreRow({ store: makeStore({ id: 'closing', closePendingAt: NOW }) }),
      makeStoreRow({ store: makeStore({ id: 'closed', closedAt: NOW }) }),
      makeStoreRow({ store: makeStore({ id: 'active' }) }),
    ];
    const only = (state: StoreStateFilter) =>
      filterAndSortStoreRows(rows, { q: '', sortCol: 'name', sortDir: 'asc', state }).map((r) => r.store.id);
    expect(only('blocked')).toEqual(['blocked']);
    expect(only('paused')).toEqual(['paused']);
    expect(only('closing')).toEqual(['closing']);
    expect(only('closed')).toEqual(['closed']);
    expect(only('active')).toEqual(['active']);
    expect(only('all')).toHaveLength(5);
  });
});

describe('countStoreStates', () => {
  it('counts every state, and the counts add up to the whole list', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ id: 'a1' }) }),
      makeStoreRow({ store: makeStore({ id: 'a2' }) }),
      makeStoreRow({ store: makeStore({ id: 'p1', pausedAt: NOW }) }),
      makeStoreRow({ store: makeStore({ id: 'c1', closePendingAt: NOW }) }),
      makeStoreRow({ store: makeStore({ id: 'b1', blocked: true }) }),
    ];
    const counts = countStoreStates(rows);
    expect(counts).toEqual({ all: 5, active: 2, paused: 1, closing: 1, closed: 0, blocked: 1 });
    // The chips must partition the list — a store counted twice, or not at all, would make the
    // numbers on screen disagree with the rows behind them.
    const { all, ...states } = counts;
    expect(Object.values(states).reduce((a, b) => a + b, 0)).toBe(all);
  });
});

describe('parseStoreQuery', () => {
  it('falls back to every store for a hand-edited state', () => {
    expect(parseStoreQuery(new URLSearchParams('ststate=nonsense')).state).toBe('all');
    expect(parseStoreQuery(new URLSearchParams()).state).toBe('all');
    expect(parseStoreQuery(new URLSearchParams('ststate=closing')).state).toBe('closing');
  });

  // The parameter the filter used while it was a yes/no toggle. An admin's saved link must keep
  // meaning what it meant rather than silently widening to every store.
  it('still honours the old blocked-only parameter', () => {
    expect(parseStoreQuery(new URLSearchParams('stblocked=1')).state).toBe('blocked');
  });
});
