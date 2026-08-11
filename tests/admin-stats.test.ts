import { describe, expect, it } from 'vitest';
import { filterAndSortSellerCards, filterAndSortStoreRows, countStoreStates, countEmptyStores, parseStoreQuery, type SellerCardData, type StoreRow, type StoreStateFilter } from '../src/lib/admin-stats.js';

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


function makeSeller(overrides: Partial<Seller> = {}): Seller {
  return { id: 'seller1', name: 'Seller', email: 'seller@example.com', passwordHash: '', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function makeSellerCard(overrides: Partial<SellerCardData> = {}, storeOverrides: Partial<Store> = {}): SellerCardData {
  const seller = makeSeller(overrides.seller);
  return {
    seller,
    stores: [{ store: makeStore({ sellerId: seller.id, ...storeOverrides }), products: [], productCount: 0, revenue: { totalRevenueAgorot: 0, monthRevenueAgorot: 0 } }],
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
    const result = filterAndSortSellerCards(cards, { q: '', sortCol: 'joined', sortDir: 'desc', blockedOnly: false, payoutState: 'all' });
    expect(result.map((c) => c.seller.id)).toEqual(['s2', 's1']);
  });

  it('sorts by revenue when requested', () => {
    const cards = [
      makeSellerCard({ seller: makeSeller({ id: 's1' }), revenue: { totalRevenueAgorot: 50, monthRevenueAgorot: 0 } }),
      makeSellerCard({ seller: makeSeller({ id: 's2' }), revenue: { totalRevenueAgorot: 200, monthRevenueAgorot: 0 } }),
    ];
    const result = filterAndSortSellerCards(cards, { q: '', sortCol: 'revenue', sortDir: 'desc', blockedOnly: false, payoutState: 'all' });
    expect(result.map((c) => c.seller.id)).toEqual(['s2', 's1']);
  });

  it('filters to only sellers with a blocked store when blockedOnly is set', () => {
    const cards = [
      makeSellerCard({ seller: makeSeller({ id: 's1' }) }, { blocked: true }),
      makeSellerCard({ seller: makeSeller({ id: 's2' }) }, { blocked: false }),
    ];
    const result = filterAndSortSellerCards(cards, { q: '', sortCol: 'joined', sortDir: 'desc', blockedOnly: true, payoutState: 'all' });
    expect(result.map((c) => c.seller.id)).toEqual(['s1']);
  });

  /**
   * The payout filter replaced the admin's per-seller payout TABLE (owner, סשן א׳ §3), so it is
   * the only way left to find the sellers whose money cannot be sent. Two things have to hold, and
   * the second is the one that would rot quietly: a seller the plan says nothing about must not
   * match a state filter. `planPayouts` drops the settled rows, so "absent" means "nothing is
   * moving" — matching them into "תקוע — אין פרטי בנק" would report the whole platform as stuck.
   */
  it('narrows to one payout state, and never matches a seller the plan says nothing about', () => {
    const cards = [
      makeSellerCard({ seller: makeSeller({ id: 's1' }) }),
      makeSellerCard({ seller: makeSeller({ id: 's2' }) }),
      makeSellerCard({ seller: makeSeller({ id: 's3' }) }),
    ];
    const states = new Map([['s1', 'no_bank'], ['s2', 'payable']]);
    const query = { q: '', sortCol: 'joined', sortDir: 'desc', blockedOnly: false } as const;
    expect(filterAndSortSellerCards(cards, { ...query, payoutState: 'no_bank' }, states).map((c) => c.seller.id)).toEqual(['s1']);
    expect(filterAndSortSellerCards(cards, { ...query, payoutState: 'payable' }, states).map((c) => c.seller.id)).toEqual(['s2']);
    // s3 is in no state at all and must fall out of every one of them.
    expect(filterAndSortSellerCards(cards, { ...query, payoutState: 'below_minimum' }, states)).toEqual([]);
    // ...and 'all' still shows everybody, including s3.
    expect(filterAndSortSellerCards(cards, { ...query, payoutState: 'all' }, states)).toHaveLength(3);
  });

  it('shows everybody when the map is missing entirely — the filter cannot hide a tab', () => {
    const cards = [makeSellerCard({ seller: makeSeller({ id: 's1' }) })];
    expect(filterAndSortSellerCards(cards, { q: '', sortCol: 'joined', sortDir: 'desc', blockedOnly: false, payoutState: 'all' })).toHaveLength(1);
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
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'name', sortDir: 'asc', state: 'all', emptyOnly: false });
    expect(result.map((r) => r.store.name)).toEqual(['א חנות', 'ב חנות']);
  });

  it('sorts by product count when requested', () => {
    const rows = [
      makeStoreRow({ store: makeStore({ id: 's1' }), productCount: 2 }),
      makeStoreRow({ store: makeStore({ id: 's2' }), productCount: 10 }),
    ];
    const result = filterAndSortStoreRows(rows, { q: '', sortCol: 'products', sortDir: 'desc', state: 'all', emptyOnly: false });
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
      filterAndSortStoreRows(rows, { q: '', sortCol: 'name', sortDir: 'asc', state, emptyOnly: false }).map((r) => r.store.id);
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

/**
 * The retired "לתשומת לב" tab (owner, סשן ב׳ §1). It listed exactly one thing — a store with no
 * products — so it is a filter on the tab that already lists those stores. Two properties matter
 * and neither held for the tab: it composes with the state filter (a store can be paused AND
 * empty), and its count is over every store, so selecting the chip does not change what it says.
 */
describe('the empty-catalogue filter', () => {
  const empty = makeStoreRow({ store: makeStore({ id: 'empty' }), productCount: 0 });
  const stocked = makeStoreRow({ store: makeStore({ id: 'stocked' }), productCount: 4 });
  const emptyPaused = makeStoreRow({ store: makeStore({ id: 'empty-paused', pausedAt: NOW }), productCount: 0 });
  const rows = [empty, stocked, emptyPaused];
  const query = { q: '', sortCol: 'name', sortDir: 'asc' } as const;

  it('counts every store with an empty catalogue, whatever its lifecycle state', () => {
    expect(countEmptyStores(rows)).toBe(2);
    expect(countEmptyStores([stocked])).toBe(0);
  });

  it('narrows to the empty ones, and composes with the state filter instead of replacing it', () => {
    const ids = (q: Parameters<typeof filterAndSortStoreRows>[1]) =>
      filterAndSortStoreRows(rows, q).map((r) => r.store.id);
    expect(ids({ ...query, state: 'all', emptyOnly: true })).toEqual(['empty', 'empty-paused']);
    expect(ids({ ...query, state: 'paused', emptyOnly: true })).toEqual(['empty-paused']);
    expect(ids({ ...query, state: 'all', emptyOnly: false })).toHaveLength(3);
  });

  it('is off unless the parameter says so — a hand-edited value cannot leave a filter on', () => {
    expect(parseStoreQuery(new URLSearchParams('stempty=1')).emptyOnly).toBe(true);
    expect(parseStoreQuery(new URLSearchParams('stempty=yes')).emptyOnly).toBe(false);
    expect(parseStoreQuery(new URLSearchParams()).emptyOnly).toBe(false);
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
