import { describe, it, expect } from 'vitest';
import {
  buildPlatformSales,
  buildPlatformPerformance,
  parseStoreRowsQuery,
  selectStoreRows,
  STORE_ROWS_PAGE_SIZE,
  type PlatformStoreRow,
} from '../src/lib/platform-performance.js';
import type { Order } from '../src/lib/orders.js';
import type { StoreViewStats } from '../src/lib/store-pageviews.js';

// A minimal paid order touching one or more stores. Only the fields
// buildPerformanceSummary reads are populated.
//
// Traffic is an INPUT now, and these tests are about the money aggregation, so they pass none: a
// store absent from the map gets EMPTY_VIEW_STATS. That is the same zero these assertions always
// ran against, except it used to depend on the real store-pageviews.json happening not to contain
// slugs called 'alpha' and 'beta'.
function makeOrder(
  id: string,
  subtotals: Record<string, number>,
  createdAt: string,
  items: Order['items'] = [],
  status: Order['paymentStatus'] = 'paid',
): Order {
  const storeSubtotals: Order['storeSubtotals'] = {};
  for (const [slug, subtotal] of Object.entries(subtotals)) {
    storeSubtotals[slug] = { storeName: slug, subtotalAgorot: subtotal, shippingAgorot: 0 };
  }
  const totalAgorot = Object.values(subtotals).reduce((s, v) => s + v, 0);
  return {
    id,
    buyerName: 'x', buyerEmail: 'x@x.co', buyerPhone: '',
    buyerAddress: { city: '', street: '' },
    items,
    storeSubtotals,
    shippingAgorot: 0,
    totalAgorot,
    paymentStatus: status,
    shippingStatus: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}

// Commission is now per-store (it comes from each store's SELLER tier), so the fixture carries
// it explicitly instead of one platform-wide rate being passed at the call site.
const STORES = [
  { id: 'alpha', slug: 'alpha', name: 'Alpha', commissionPercent: 10 },
  { id: 'beta', slug: 'beta', name: 'Beta', commissionPercent: 10 },
  { id: 'gamma', slug: 'gamma', name: 'Gamma', commissionPercent: 10 },
];
const NO_VIEWS = new Map<string, StoreViewStats>();
const FROM = '2026-07-01';
const TO = '2026-07-31';

describe('buildPlatformPerformance — aggregation across stores', () => {
  it('sums revenue and orders across every store', () => {
    const orders = [
      makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { beta: 500 }, '2026-07-06T10:00:00.000Z'),
      makeOrder('o3', { alpha: 250 }, '2026-07-07T10:00:00.000Z'),
    ];
    const p = buildPlatformPerformance(buildPlatformSales(orders, STORES.map((s) => s.slug), FROM, TO, 'day'), STORES, NO_VIEWS, FROM, TO, 'day');
    expect(p.summary.totalRevenueAgorot).toBe(1750);
    expect(p.summary.totalOrders).toBe(3);
    // commission (platform income) + payout (to sellers) reconcile to GMV
    expect(p.summary.platformCommissionAgorot).toBe(175);
    expect(p.summary.netProfitAgorot).toBe(1575);
    expect(p.summary.platformCommissionAgorot + p.summary.netProfitAgorot).toBe(p.summary.totalRevenueAgorot);
  });

  it('counts a multi-store order toward each store it touched', () => {
    const orders = [makeOrder('o1', { alpha: 300, beta: 200 }, '2026-07-05T10:00:00.000Z')];
    const p = buildPlatformPerformance(buildPlatformSales(orders, STORES.map((s) => s.slug), FROM, TO, 'day'), STORES, NO_VIEWS, FROM, TO, 'day');
    // orders sum reconciles with the breakdown rows (alpha:1 + beta:1)
    expect(p.summary.totalOrders).toBe(2);
    const alpha = p.stores.find((s) => s.slug === 'alpha');
    const beta = p.stores.find((s) => s.slug === 'beta');
    expect(alpha?.revenueAgorot).toBe(300);
    expect(beta?.revenueAgorot).toBe(200);
    expect(p.stores.reduce((s, r) => s + r.orders, 0)).toBe(p.summary.totalOrders);
  });

  it('ignores unpaid orders (same rule as the seller summary)', () => {
    const orders = [
      makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { alpha: 999 }, '2026-07-06T10:00:00.000Z', [], 'pending'),
    ];
    const p = buildPlatformPerformance(buildPlatformSales(orders, STORES.map((s) => s.slug), FROM, TO, 'day'), STORES, NO_VIEWS, FROM, TO, 'day');
    expect(p.summary.totalRevenueAgorot).toBe(1000);
    expect(p.summary.totalOrders).toBe(1);
  });

  it('builds a revenue-desc breakdown, flagging (not dropping) stores idle in range', () => {
    const orders = [
      makeOrder('o1', { beta: 900 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { alpha: 100 }, '2026-07-06T10:00:00.000Z'),
      // gamma has no orders and no views → present but active:false, so a search
      // can still find it while browsing hides it (selectStoreRows).
    ];
    const p = buildPlatformPerformance(buildPlatformSales(orders, STORES.map((s) => s.slug), FROM, TO, 'day'), STORES, NO_VIEWS, FROM, TO, 'day');
    expect(p.stores.map((s) => s.slug)).toEqual(['beta', 'alpha', 'gamma']);
    expect(p.stores.map((s) => s.active)).toEqual([true, true, false]);
    // totalStores counts only the active ones — the default table universe.
    expect(p.totalStores).toBe(2);
  });

  it('aggregates platform top products across stores and honours topLimit', () => {
    const items = (slug: string, productId: string, name: string, priceAgorot: number, qty: number): Order['items'] =>
      [{ productId, productName: name, productSlug: productId, storeSlug: slug, storeName: slug, priceAgorot, qty }];
    const orders = [
      makeOrder('o1', { alpha: 200 }, '2026-07-05T10:00:00.000Z', items('alpha', 'p1', 'Widget', 100, 2)),
      makeOrder('o2', { beta: 300 }, '2026-07-06T10:00:00.000Z', items('beta', 'p2', 'Gadget', 300, 1)),
      makeOrder('o3', { alpha: 100 }, '2026-07-07T10:00:00.000Z', items('alpha', 'p1', 'Widget', 100, 1)),
    ];
    const p = buildPlatformPerformance(buildPlatformSales(orders, STORES.map((s) => s.slug), FROM, TO, 'day', 5), STORES, NO_VIEWS, FROM, TO, 'day');
    const p1 = p.summary.topProducts.find((t) => t.productId === 'p1');
    expect(p1?.units).toBe(3);       // 2 + 1 across two orders
    expect(p1?.revenueAgorot).toBe(300);   // 100 * 3
    // revenue-desc: gadget (300) ties widget (300) — both present, capped by topLimit
    expect(p.summary.topProducts.length).toBe(2);

    const capped = buildPlatformPerformance(buildPlatformSales(orders, STORES.map((s) => s.slug), FROM, TO, 'day', 1), STORES, NO_VIEWS, FROM, TO, 'day');
    expect(capped.summary.topProducts.length).toBe(1);
  });

  it('attributes each store\'s traffic by ID, not by slug', () => {
    // The fixtures above use id === slug, which would let a lookup keyed on the wrong field pass
    // every other test in this file. Here they differ deliberately: page-view history is gathered
    // under the store id precisely so a URL rename cannot orphan it (DB_MIGRATION_PLAN.md §5), and
    // a merge that reached for `store.slug` would report zero traffic for the entire platform.
    const stores = [
      { id: 'store-id-1', slug: 'alpha', name: 'Alpha', commissionPercent: 10 },
      { id: 'store-id-2', slug: 'beta', name: 'Beta', commissionPercent: 10 },
    ];
    const views = new Map<string, StoreViewStats>([
      ['store-id-1', { buckets: [{ key: '2026-07-05', views: 30, uniqueVisitors: 9 }], totalViews: 30, totalUniqueVisitors: 9 }],
      ['store-id-2', { buckets: [{ key: '2026-07-05', views: 12, uniqueVisitors: 4 }], totalViews: 12, totalUniqueVisitors: 4 }],
    ]);
    const p = buildPlatformPerformance(buildPlatformSales([], stores.map((s) => s.slug), FROM, TO, 'day'), stores, views, FROM, TO, 'day');

    expect(p.summary.totalViews).toBe(42);
    expect(p.summary.points.find((pt) => pt.key === '2026-07-05')!.views).toBe(42);
    expect(p.stores.find((r) => r.slug === 'alpha')!.views).toBe(30);
    expect(p.stores.find((r) => r.slug === 'beta')!.views).toBe(12);
    // Traffic alone makes a store active — the breakdown table must not hide a store that got
    // visitors and no sales, which is exactly the store its owner needs to look at.
    expect(p.stores.every((r) => r.active)).toBe(true);
  });

  it('zero-fills the point axis for an empty platform', () => {
    const p = buildPlatformPerformance(buildPlatformSales([], STORES.map((s) => s.slug), FROM, TO, 'day'), STORES, NO_VIEWS, FROM, TO, 'day');
    expect(p.summary.totalRevenueAgorot).toBe(0);
    expect(p.summary.points.length).toBe(31); // full July, zero-filled
    expect(p.summary.points.every((pt) => pt.revenueAgorot === 0 && pt.orders === 0)).toBe(true);
    // Rows still exist for every store (searchable), none of them active.
    expect(p.stores.length).toBe(STORES.length);
    expect(p.totalStores).toBe(0);
  });

  it('returns EVERY store, uncapped — paging is the caller\'s job now', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, slug: `s${i}`, name: `S${i}` }));
    const orders = many.map((s, i) => makeOrder(`o${i}`, { [s.slug]: (i + 1) * 10 }, '2026-07-05T10:00:00.000Z'));
    const p = buildPlatformPerformance(buildPlatformSales(orders, many.map((s) => s.slug), FROM, TO, 'day', 5), many, NO_VIEWS, FROM, TO, 'day');
    expect(p.stores.length).toBe(40);
    expect(p.totalStores).toBe(40);
    // highest-revenue store leads
    expect(p.stores[0]!.revenueAgorot).toBeGreaterThanOrEqual(p.stores[1]!.revenueAgorot);
  });
});

// ── Breakdown table: search + sort + pagination (CURRENT_TASK.md → סשן ב׳ #1) ──

function row(slug: string, name: string, revenueAgorot: number, orders = 0, views = 0, conversionRate = 0): PlatformStoreRow {
  return { slug, name, blocked: false, revenueAgorot, orders, views, conversionRate, active: revenueAgorot > 0 || orders > 0 || views > 0 };
}
const ROWS: PlatformStoreRow[] = [
  row('gadget-shop', 'חנות הגאדג׳טים', 900, 9, 90, 10),
  row('book-nook', 'Book Nook', 500, 5, 200, 2.5),
  row('candle-co', 'Candle Co', 100, 1, 50, 2),
];
// A store that exists but did nothing in the range — hidden while browsing, findable by search.
const IDLE = row('quiet-shop', 'Quiet Shop', 0, 0, 0, 0);
const ROWS_WITH_IDLE: PlatformStoreRow[] = [...ROWS, IDLE];

describe('selectStoreRows', () => {
  it('defaults to revenue-desc, page 1', () => {
    const p = selectStoreRows(ROWS, { q: '', sort: 'revenue', dir: 'desc', page: 1 });
    expect(p.rows.map((r) => r.slug)).toEqual(['gadget-shop', 'book-nook', 'candle-co']);
    expect(p.total).toBe(3);
    expect(p.matched).toBe(3);
    expect(p.totalPages).toBe(1);
  });

  it('hides zero-activity stores while browsing, but a SEARCH finds them', () => {
    const browsing = selectStoreRows(ROWS_WITH_IDLE, { q: '', sort: 'revenue', dir: 'desc', page: 1 });
    expect(browsing.rows.some((r) => r.slug === 'quiet-shop')).toBe(false);
    expect(browsing.total).toBe(3); // active only

    const searching = selectStoreRows(ROWS_WITH_IDLE, { q: 'quiet', sort: 'revenue', dir: 'desc', page: 1 });
    expect(searching.rows.map((r) => r.slug)).toEqual(['quiet-shop']);
    expect(searching.rows[0]!.active).toBe(false); // flagged, so the UI can label it
    expect(searching.matched).toBe(1);
    expect(searching.total).toBe(4); // searching spans EVERY store, not just active ones
  });

  it('searches by name AND slug, case-insensitively, keeping `total` at the unfiltered count', () => {
    const byName = selectStoreRows(ROWS, { q: 'book', sort: 'revenue', dir: 'desc', page: 1 });
    expect(byName.rows.map((r) => r.slug)).toEqual(['book-nook']);
    expect(byName.matched).toBe(1);
    expect(byName.total).toBe(3);

    // Hebrew store name, matched by a fragment of its Latin slug.
    expect(selectStoreRows(ROWS, { q: 'GADGET', sort: 'revenue', dir: 'desc', page: 1 }).rows[0]!.slug)
      .toBe('gadget-shop');
    expect(selectStoreRows(ROWS, { q: 'גאדג', sort: 'revenue', dir: 'desc', page: 1 }).matched).toBe(1);
    expect(selectStoreRows(ROWS, { q: 'nothing-here', sort: 'revenue', dir: 'desc', page: 1 }).rows).toEqual([]);
  });

  it('sorts by any column in either direction', () => {
    const byViews = selectStoreRows(ROWS, { q: '', sort: 'views', dir: 'desc', page: 1 });
    expect(byViews.rows.map((r) => r.slug)).toEqual(['book-nook', 'gadget-shop', 'candle-co']);
    const cheapestFirst = selectStoreRows(ROWS, { q: '', sort: 'revenue', dir: 'asc', page: 1 });
    expect(cheapestFirst.rows[0]!.slug).toBe('candle-co');
  });

  it('sorts within the SEARCH results, not the whole set', () => {
    const p = selectStoreRows(ROWS, { q: 'o', sort: 'revenue', dir: 'asc', page: 1 });
    // 'o' hits all three slugs; asc within them
    expect(p.rows.map((r) => r.slug)).toEqual(['candle-co', 'book-nook', 'gadget-shop']);
  });

  it(`pages at ${STORE_ROWS_PAGE_SIZE} and clamps an out-of-range page`, () => {
    const many = Array.from({ length: 23 }, (_, i) => row(`s${i}`, `S${i}`, i + 1));
    const first = selectStoreRows(many, { q: '', sort: 'revenue', dir: 'desc', page: 1 });
    expect(first.rows.length).toBe(STORE_ROWS_PAGE_SIZE);
    expect(first.totalPages).toBe(3);

    const last = selectStoreRows(many, { q: '', sort: 'revenue', dir: 'desc', page: 3 });
    expect(last.rows.length).toBe(3);
    // No overlap between pages — page 2 continues where page 1 stopped.
    const second = selectStoreRows(many, { q: '', sort: 'revenue', dir: 'desc', page: 2 });
    expect(second.rows[0]!.slug).not.toBe(first.rows[STORE_ROWS_PAGE_SIZE - 1]!.slug);

    // A search that shrinks the set below the current page → clamped, and the
    // clamped page is echoed back so the client can adopt it.
    const clamped = selectStoreRows(many, { q: 's1', sort: 'revenue', dir: 'desc', page: 9 });
    expect(clamped.page).toBe(clamped.totalPages);
    expect(clamped.query.page).toBe(clamped.page);
    expect(clamped.rows.length).toBeGreaterThan(0);
  });

  it('never mutates the caller\'s array', () => {
    const original = [...ROWS];
    selectStoreRows(ROWS, { q: '', sort: 'orders', dir: 'asc', page: 1 });
    expect(ROWS).toEqual(original);
  });
});

describe('parseStoreRowsQuery', () => {
  it('reads valid params', () => {
    const q = parseStoreRowsQuery(new URLSearchParams('storeQ=%20book%20&storeSort=views&storeDir=asc&storePage=4'));
    expect(q).toEqual({ q: 'book', sort: 'views', dir: 'asc', page: 4 });
  });

  it('falls back to safe defaults on junk instead of throwing', () => {
    const q = parseStoreRowsQuery(new URLSearchParams('storeSort=DROP TABLE&storeDir=sideways&storePage=-7'));
    expect(q).toEqual({ q: '', sort: 'revenue', dir: 'desc', page: 1 });
    expect(parseStoreRowsQuery(new URLSearchParams()).page).toBe(1);
  });

  it('bounds the search string so a huge query cannot drive a huge scan', () => {
    const q = parseStoreRowsQuery(new URLSearchParams(`storeQ=${'a'.repeat(500)}`));
    expect(q.q.length).toBe(80);
  });
});

describe('mixed-tier commission', () => {
  it('applies each store its own rate and reports the blended actual, not one tier', () => {
    const mixed = [
      { id: 'alpha', slug: 'alpha', name: 'Alpha', commissionPercent: 12 }, // starter
      { id: 'beta', slug: 'beta', name: 'Beta', commissionPercent: 4 },    // enterprise
    ];
    const orders = [
      makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z'),
      makeOrder('o2', { beta: 1000 }, '2026-07-06T10:00:00.000Z'),
    ];
    const p = buildPlatformPerformance(buildPlatformSales(orders, mixed.map((s) => s.slug), FROM, TO, 'day'), mixed, NO_VIEWS, FROM, TO, 'day');
    expect(p.summary.totalRevenueAgorot).toBe(2000);
    expect(p.summary.platformCommissionAgorot).toBe(160); // 120 + 40, NOT 2000 * one rate
    expect(p.summary.commissionRate).toBe(8);       // revenue-weighted blend
    expect(p.summary.platformCommissionAgorot + p.summary.netProfitAgorot).toBe(p.summary.totalRevenueAgorot);
  });

  it('takes no commission from a store whose rate is absent', () => {
    const p = buildPlatformPerformance(buildPlatformSales([makeOrder('o1', { alpha: 1000 }, '2026-07-05T10:00:00.000Z')], [{ id: 'alpha', slug: 'alpha', name: 'Alpha' }].map((s) => s.slug), FROM, TO, 'day'), [{ id: 'alpha', slug: 'alpha', name: 'Alpha' }], NO_VIEWS, FROM, TO, 'day');
    expect(p.summary.platformCommissionAgorot).toBe(0);
    expect(p.summary.commissionRate).toBe(0);
  });
});
