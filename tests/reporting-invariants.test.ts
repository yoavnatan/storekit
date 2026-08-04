import { beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Order } from '../src/lib/orders.js';
import { countsAsRevenue } from '../src/lib/orders.js';
import { query } from '../src/lib/db.js';
import { getAdminOrdersPage } from '../src/lib/orders.js';
import { getAllStores, getStoresWithFeedUrl } from '../src/lib/stores.js';
import { JOBS } from '../src/lib/jobs/registry.js';
import { getAllSellers, getSubscriptionAccrual } from '../src/lib/seller-auth.js';
import { getProductCountsByStore, getProductsByStoreIds, isProductVisible } from '../src/lib/store-products.js';
import { getCampaignsInRange, getCampaignTotals, campaignTotalsOf } from '../src/lib/ad-campaigns.js';
import { countOpenOrdersByStore } from '../src/lib/store-lifecycle.js';
import { buildSellerFunnel, getSellerFunnel } from '../src/lib/seller-funnel.js';
import { reconcileOrders, reconcilePlatform } from '../src/lib/reconcile.js';
import { daysInRangeInclusive } from '../src/lib/date-range.js';
import { getOpenOrderCountsByStore, getPlatformOrderTotals, getPlatformSales, getStoreRevenueBySlug } from '../src/lib/order-reporting.js';

import { buildPerformanceSummary, buildProductPerformance } from '../src/lib/seller-performance.js';
import { buildPlatformPerformance, buildPlatformSales } from '../src/lib/platform-performance.js';
import { buildSellerBalances, type SellerBalance } from '../src/lib/seller-balance.js';

/** The platform-wide totals of a balance list. In the test rather than the module: no screen shows
 *  this figure (the admin Performance tab already reports what is paid out to sellers), and an
 *  exported helper with no caller reads as one that is wired to something. */
const platformTotals = (bs: readonly SellerBalance[]) => ({
  grossRevenueAgorot: bs.reduce((a, b) => a + b.grossRevenueAgorot, 0),
  commissionAgorot: bs.reduce((a, b) => a + b.commissionAgorot, 0),
  totalEarnedAgorot: bs.reduce((a, b) => a + b.totalEarnedAgorot, 0),
});
import { commissionPercentForTier } from '../src/lib/pricing.js';
// Traffic is an input now; these invariants are about money, so they assert against no traffic.
import { EMPTY_VIEW_STATS, type StoreViewStats } from '../src/lib/store-pageviews.js';
import { EMPTY_PRODUCT_VIEW_STATS } from '../src/lib/product-pageviews.js';
const NO_VIEWS = new Map<string, StoreViewStats>();
import { getOrderTotals, getStoreOverview, getStoreRevenueMap, orderNetForStore, orderNetTotal } from '../src/lib/admin-stats.js';
import { businessDayISO, businessMonthKey, BUSINESS_TIMEZONE } from '../src/lib/business-day.js';
import { storeSliceTotalAgorot } from '../src/lib/order-totals.js';

/** The business month `getStoreRevenueMap`'s month column is asked about. These assertions are
 *  about the ALL-TIME column, so the month is a constant that no clock decides. */
const MONTH = '2026-01';


/**
 * INVARIANTS — statements that must hold for EVERY input, not examples of bugs
 * already found.
 *
 * The distinction matters, and it is the whole reason this file exists. A normal
 * test encodes a scenario someone thought of; it can only catch the bug its author
 * already imagined. An invariant encodes a truth about the system ("the parts sum to
 * the whole", "no report can show money an order never carried"), so it fails on
 * bugs nobody imagined — including ones introduced years from now by someone who
 * never read this file.
 *
 * Two of the checks below run over the REAL data/orders.json rather than fixtures.
 * That makes them a standing audit of the actual data as well as of the code: a
 * malformed order written by a past bug, or by a hand edit, fails the suite instead
 * of sitting quietly inside a total.
 *
 * ⚠️ A passing run over real data proves less than it looks like it does while
 * payment is still stubbed to always approve (CURRENT_TASK #2): there are no failed
 * or pending orders in the file yet, so any rule about them is currently vacuous.
 * That is exactly why the fixture-driven invariants below construct those states by
 * hand instead of trusting the file to contain them.
 */

const STORE = 'inv-store';
const OTHER = 'inv-other';

interface OrderOverrides { [k: string]: unknown }

function makeOrder(id: string, opts: {
  items: Array<{ productId: string; priceAgorot: number; qty: number; storeSlug?: string }>;
  shippingAgorot?: number;
  discount?: { type: 'percent' | 'amount'; value: number; appliedAgorot: number };
  createdAt?: string;
  over?: OrderOverrides;
}): Order {
  const items = opts.items.map((i) => ({
    productId: i.productId,
    productName: `name-${i.productId}`,
    productSlug: `slug-${i.productId}`,
    storeSlug: i.storeSlug ?? STORE,
    storeName: 'S',
    priceAgorot: i.priceAgorot,
    qty: i.qty,
  }));
  const shippingAgorot = opts.shippingAgorot ?? 0;
  const bySlug = new Map<string, number>();
  for (const i of items) bySlug.set(i.storeSlug, (bySlug.get(i.storeSlug) ?? 0) + i.priceAgorot * i.qty);

  const storeSubtotals: Record<string, { storeName: string; subtotalAgorot: number; shippingAgorot: number; discount?: typeof opts.discount }> = {};
  for (const [slug, subtotal] of bySlug) {
    storeSubtotals[slug] = { storeName: 'S', subtotalAgorot: subtotal, shippingAgorot, ...(slug === STORE && opts.discount ? { discount: opts.discount } : {}) };
  }
  const totalAgorot = Object.values(storeSubtotals)
    .reduce((s, st) => s + st.subtotalAgorot + st.shippingAgorot - (st.discount?.appliedAgorot ?? 0), 0);

  return {
    id,
    buyerName: 'B', buyerEmail: 'b@x.test', buyerPhone: '0500000000',
    buyerAddress: { city: 'C', street: 'S' },
    items,
    storeSubtotals,
    shippingAgorot,
    totalAgorot,
    paymentStatus: 'paid',
    shippingStatus: 'delivered',
    createdAt: opts.createdAt ?? '2026-07-15T10:00:00.000Z',
    updatedAt: opts.createdAt ?? '2026-07-15T10:00:00.000Z',
    ...(opts.over ?? {}),
  } as Order;
}

/** Money equality. Both sides are rounded to agorot by lib/money.ts, so this is an
 *  exact compare on purpose — a tolerance here would hide the very drift the
 *  rounding exists to remove. */
/** Exact equality. It used to round both sides to the agora, because two float routes to one
 *  amount land a hair apart; both sides are integer agorot now, so rounding would hide exactly the
 *  drift these invariants exist to catch. */
function expectSameMoney(actual: number, expected: number, label: string): void {
  expect(actual, label).toBe(expected);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. An order's own arithmetic must close.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reusable so the same rules run over fixtures AND over the stored orders below.
 *
 * **`legacyRounding` exists for one measured reason and must never be passed for a NEW order.**
 * An order written since the unit flip holds integer agorot end to end, so every identity here is
 * exact. An order IMPORTED from the ILS era cannot be: the file stored a per-line price and a
 * pre-computed subtotal as separate decimal numbers, and converting each of them independently
 * does not commute with multiplying. Measured on the fixture, whose 1.005 ₪ line was chosen for
 * exactly this: `toAgorot(1.005) × 2 = 202` while `toAgorot(2.01) = 201`.
 *
 * The stored subtotal is the one that is right — it is what the buyer was charged — so the import
 * keeps it rather than re-deriving it from the lines, and the residue is at most one agora per
 * line. That is the bound allowed here, and nothing larger: a real edit that touched one side
 * without the other moves the number by far more than a rounding tail. `reconcile.ts` reports
 * these rows on the live data too, which is where an owner sees them.
 */
function assertOrderIsInternallyConsistent(o: Order, where: string, legacyRounding = false): void {
  const label = `${where} order ${o.id}`;

  // The line items must account for exactly the store's subtotal. If they don't,
  // some path edited one without the other and the seller's product breakdown will
  // never add up to their revenue headline.
  for (const [slug, sub] of Object.entries(o.storeSubtotals)) {
    const lines = o.items.filter((i) => i.storeSlug === slug);
    const fromItems = lines.reduce((s, i) => s + i.priceAgorot * i.qty, 0);
    const slack = legacyRounding ? lines.length : 0;
    expect(Math.abs(sub.subtotalAgorot - fromItems), `${label} / ${slug}: subtotal vs sum of its line items`)
      .toBeLessThanOrEqual(slack);
  }

  // totalAgorot is the buyer-facing number. It must equal net + shipping across
  // every store on the order — the identity that lets the admin GMV headline and
  // the per-store rows reconcile.
  const expectedTotal = Object.entries(o.storeSubtotals)
    .reduce((s, [slug, sub]) => s + orderNetForStore(o, slug) + sub.shippingAgorot, 0);
  // Both sides are built from the STORED subtotals here, not from the lines, so this identity is
  // exact even for an imported order — the rounding residue above never reaches it.
  expectSameMoney(o.totalAgorot, expectedTotal, `${label}: totalAgorot vs sum(net + shipping)`);

  assertStoredAmountsAreSane(o, where);
}

/** The half of the rules that holds for ANY order, whoever wrote it and whenever. */
function assertStoredAmountsAreSane(o: Order, where: string): void {
  const label = `${where} order ${o.id}`;
  // No negative money anywhere, and a discount can never exceed what it discounts.
  expect(o.totalAgorot, `${label}: totalAgorot is not negative`).toBeGreaterThanOrEqual(0);
  for (const [slug, sub] of Object.entries(o.storeSubtotals)) {
    expect(sub.subtotalAgorot, `${label} / ${slug}: subtotal is not negative`).toBeGreaterThanOrEqual(0);
    expect(sub.shippingAgorot, `${label} / ${slug}: shipping is not negative`).toBeGreaterThanOrEqual(0);
    const applied = sub.discount?.appliedAgorot ?? 0;
    expect(applied, `${label} / ${slug}: discount is not negative`).toBeGreaterThanOrEqual(0);
    expect(applied, `${label} / ${slug}: discount does not exceed subtotal + shipping`)
      .toBeLessThanOrEqual(sub.subtotalAgorot + sub.shippingAgorot);
  }
  for (const i of o.items) {
    expect(i.priceAgorot, `${label}: item ${i.productId} price is not negative`).toBeGreaterThanOrEqual(0);
    expect(i.qty, `${label}: item ${i.productId} qty is a positive integer`).toBeGreaterThan(0);
    expect(Number.isInteger(i.qty), `${label}: item ${i.productId} qty is a whole number`).toBe(true);
  }

  // Every stored amount is already in agorot. A value that fails this arrived from
  // an unrounded `+=` somewhere and will show up in a CSV export or be handed to a
  // payment processor with twelve decimal places.
  const amounts: Array<[number, string]> = [
    [o.totalAgorot, 'totalAgorot'],
    [o.shippingAgorot, 'shippingAgorot'],
    ...Object.entries(o.storeSubtotals).flatMap(([slug, sub]): Array<[number, string]> => [
      [sub.subtotalAgorot, `${slug}.subtotalAgorot`],
      [sub.shippingAgorot, `${slug}.shippingAgorot`],
      [sub.discount?.appliedAgorot ?? 0, `${slug}.discount.appliedAgorot`],
    ]),
    ...o.items.map((i): [number, string] => [i.priceAgorot, `item ${i.productId} price`]),
  ];
  for (const [value, name] of amounts) {
    expectSameMoney(value, value, `${label}: ${name} is stored rounded to agorot`);
  }
}

describe('every order closes on its own arithmetic', () => {
  it('holds for a plain order', () => {
    assertOrderIsInternallyConsistent(makeOrder('a', { items: [{ productId: 'p1', priceAgorot: 1999, qty: 3 }], shippingAgorot: 2500 }), 'fixture');
  });

  it('holds for a discounted, multi-store, multi-line order', () => {
    assertOrderIsInternallyConsistent(makeOrder('b', {
      items: [
        { productId: 'p1', priceAgorot: 3333, qty: 3 },
        { productId: 'p2', priceAgorot: 10, qty: 7 },
        { productId: 'p3', priceAgorot: 1250, qty: 1, storeSlug: OTHER },
      ],
      shippingAgorot: 1990,
      discount: { type: 'percent', value: 10, appliedAgorot: 1201 },
    }), 'fixture');
  });
});

// The number the seller reads on an order card, and the number that same order contributes to
// their revenue, are two different questions (revenue excludes the carrier's fee) — but they are
// answered from the same row, so they must differ by EXACTLY the shipping. They didn't: the card
// dropped the seller's discount entirely, so a discounted order displayed more than it earned.
describe('an order card agrees with the revenue that order produces', () => {
  const cases: [string, Parameters<typeof makeOrder>[1]][] = [
    ['no discount', { items: [{ productId: 'p1', priceAgorot: 1999, qty: 3 }], shippingAgorot: 2500 }],
    ['percent discount', { items: [{ productId: 'p1', priceAgorot: 3333, qty: 3 }], shippingAgorot: 1990, discount: { type: 'percent', value: 10, appliedAgorot: 1000 } }],
    ['free shipping', { items: [{ productId: 'p1', priceAgorot: 5000, qty: 1 }], shippingAgorot: 0, discount: { type: 'amount', value: 5, appliedAgorot: 500 } }],
  ];
  for (const [name, spec] of cases) {
    it(`card total − shipping = the store's net revenue (${name})`, () => {
      const order = makeOrder('inv', spec);
      const sub = order.storeSubtotals[STORE]!;
      expectSameMoney(
        storeSliceTotalAgorot(sub) - sub.shippingAgorot,
        orderNetForStore(order, STORE),
        `${name}: the card and the revenue sum read the same row`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A report's parts must sum to its whole.
// ─────────────────────────────────────────────────────────────────────────────

describe('the seller performance summary reconciles with itself', () => {
  const orders = [
    makeOrder('o1', { items: [{ productId: 'p1', priceAgorot: 1999, qty: 3 }], shippingAgorot: 2500, createdAt: '2026-07-02T09:00:00.000Z' }),
    makeOrder('o2', { items: [{ productId: 'p2', priceAgorot: 10, qty: 7 }], shippingAgorot: 0, createdAt: '2026-07-11T09:00:00.000Z' }),
    makeOrder('o3', {
      items: [{ productId: 'p1', priceAgorot: 1999, qty: 1 }, { productId: 'p3', priceAgorot: 25000, qty: 2 }],
      shippingAgorot: 1990,
      discount: { type: 'amount', value: 40, appliedAgorot: 4000 },
      createdAt: '2026-07-20T09:00:00.000Z',
    }),
  ];

  it('the daily bars add up to the headline revenue', () => {
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(s.points.reduce((a, p) => a + p.revenueAgorot, 0), s.totalRevenueAgorot, 'sum of day buckets vs totalRevenueAgorot');
    expect(s.points.reduce((a, p) => a + p.orders, 0)).toBe(s.totalOrders);
  });

  it('the monthly bars add up to the same headline as the daily ones', () => {
    // Same window, different bucket size. If these disagree, one granularity is
    // dropping or double-counting orders at a boundary.
    const byDay = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day');
    const byMonth = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'month');
    expectSameMoney(byMonth.totalRevenueAgorot, byDay.totalRevenueAgorot, 'month total vs day total');
    expect(byMonth.totalOrders).toBe(byDay.totalOrders);
    expectSameMoney(byMonth.points.reduce((a, p) => a + p.revenueAgorot, 0), byMonth.totalRevenueAgorot, 'sum of month buckets');
  });

  it('commission plus net profit equals revenue, and neither escapes its bounds', () => {
    for (const rate of [0, 10, 10.25, 12, 100]) {
      const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day', rate);
      expectSameMoney(s.platformCommissionAgorot + s.netProfitAgorot, s.totalRevenueAgorot, `commission + net at ${rate}%`);
      expect(s.platformCommissionAgorot, `commission at ${rate}% is not negative`).toBeGreaterThanOrEqual(0);
      expect(s.platformCommissionAgorot, `commission at ${rate}% never exceeds revenue`).toBeLessThanOrEqual(s.totalRevenueAgorot);
      expect(s.netProfitAgorot, `net profit at ${rate}% is not negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('the product breakdown accounts for revenue plus exactly the discounts given', () => {
    // topProducts is GROSS (per line item); totalRevenueAgorot is NET (after the
    // order-level discount). The gap between them must be the discounts and nothing
    // else — otherwise the "leading products" list is quietly built from a different
    // set of orders than the headline above it.
    const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day', 0, 0);
    const gross = s.topProducts.reduce((a, p) => a + p.revenueAgorot, 0);
    const discounts = orders
      .filter(countsAsRevenue)
      .reduce((a, o) => a + (o.storeSubtotals[STORE]?.discount?.appliedAgorot ?? 0), 0);
    expectSameMoney(gross, s.totalRevenueAgorot + discounts, 'gross product revenue vs net revenue + discounts');
  });

  it('a single product drill-down reconciles with its own bars', () => {
    const p = buildProductPerformance(orders, EMPTY_PRODUCT_VIEW_STATS, STORE, 'p1', '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(p.points.reduce((a, x) => a + x.revenueAgorot, 0), p.totalRevenueAgorot, 'product day buckets vs its total');
    expect(p.points.reduce((a, x) => a + x.units, 0)).toBe(p.totalUnits);
    expect(p.totalUnits).toBe(4); // 3 from o1 + 1 from o3
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Two surfaces describing the same money must produce the same number.
// ─────────────────────────────────────────────────────────────────────────────

describe('the admin surfaces reconcile with each other', () => {
  const orders = [
    makeOrder('o1', { items: [{ productId: 'p1', priceAgorot: 1999, qty: 3 }], shippingAgorot: 2500 }),
    makeOrder('o2', { items: [{ productId: 'p2', priceAgorot: 555, qty: 9, storeSlug: OTHER }], shippingAgorot: 1990 }),
    makeOrder('o3', { items: [{ productId: 'p1', priceAgorot: 10000, qty: 1 }], shippingAgorot: 0, discount: { type: 'percent', value: 25, appliedAgorot: 2500 } }),
    makeOrder('cancelled', { items: [{ productId: 'p1', priceAgorot: 99900, qty: 5 }], over: { shippingStatus: 'cancelled' } }),
    makeOrder('failed', { items: [{ productId: 'p1', priceAgorot: 77700, qty: 5 }], over: { paymentStatus: 'failed' } }),
    makeOrder('pending', { items: [{ productId: 'p1', priceAgorot: 55500, qty: 5 }], over: { paymentStatus: 'pending' } }),
  ];

  it('the GMV headline equals the sum of the per-store rows', () => {
    // These are two different code paths over the same orders, on two different
    // admin tabs. The headline used to sum `order.totalAgorot` (shipping included,
    // discounts ignored) while the rows summed net subtotals, so the two could never
    // be made to agree by any amount of staring at them.
    const overview = getOrderTotals(orders);
    const rows = getStoreRevenueMap(orders, MONTH);
    const rowSum = [...rows.values()].reduce((a, r) => a + r.totalRevenueAgorot, 0);
    expectSameMoney(overview.gmvAgorot, rowSum, 'overview GMV vs sum of per-store revenue');
  });

  it('the platform performance total equals the sum of its own store breakdown', () => {
    const perf = buildPlatformPerformance(buildPlatformSales(orders, [STORE, OTHER], '2026-07-01', '2026-07-31', 'day'), [{ id: STORE, slug: STORE, name: 'S' }, { id: OTHER, slug: OTHER, name: 'O' }], NO_VIEWS, '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(
      perf.stores.reduce((a, r) => a + r.revenueAgorot, 0),
      perf.summary.totalRevenueAgorot,
      'sum of breakdown rows vs platform total',
    );
    expectSameMoney(perf.summary.points.reduce((a, p) => a + p.revenueAgorot, 0), perf.summary.totalRevenueAgorot, 'platform bars vs platform total');
  });

  it('the platform total equals what each store\'s own seller tab reports', () => {
    // The number the owner sees must be the number the sellers see, added up. A
    // platform aggregate computed by its own second implementation is the classic
    // place for the two to drift.
    const perf = buildPlatformPerformance(buildPlatformSales(orders, [STORE, OTHER], '2026-07-01', '2026-07-31', 'day'), [{ id: STORE, slug: STORE, name: 'S' }, { id: OTHER, slug: OTHER, name: 'O' }], NO_VIEWS, '2026-07-01', '2026-07-31', 'day');
    const sellerSum = [STORE, OTHER].reduce(
      (a, slug) => a + buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot, 0,
    );
    expectSameMoney(perf.summary.totalRevenueAgorot, sellerSum, 'platform total vs sum of seller tabs');
  });

  it('no surface counts an order that is not paid, or that was cancelled', () => {
    // The single predicate, asserted from the outside: whatever each surface
    // computes, adding a cancelled/failed/pending order must not move it.
    const live = orders.filter(countsAsRevenue);
    expectSameMoney(getOrderTotals(orders).gmvAgorot, getOrderTotals(live).gmvAgorot, 'overview GMV ignores dead orders');
    expectSameMoney(
      buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot,
      buildPerformanceSummary(live, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot,
      'seller revenue ignores dead orders',
    );
    expectSameMoney(
      [...getStoreRevenueMap(orders, MONTH).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0),
      [...getStoreRevenueMap(live, MONTH).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0),
      'per-store revenue ignores dead orders',
    );
  });

  it('the store count is real stores, with showcase ones counted apart', () => {
    // The showcase stores refuse checkout outright, so folding them into the
    // headline told the owner his marketplace was bigger than it is — on the one
    // card he would use to judge whether the business is actually working.
    const overview = getStoreOverview(0, [
      { slug: 'real-1', name: 'R1', sellerId: 's1' },
      { slug: 'real-2', name: 'R2', sellerId: 's1' },
      { slug: 'demo-1', name: 'D1', sellerId: 's9', demo: true },
    ] as never);
    expect(overview.totalStores).toBe(2);
    expect(overview.demoStores).toBe(1);
  });

  it('an order can never contribute more than it is worth', () => {
    // An upper bound rather than an exact figure: it holds no matter how the
    // reporting is refactored, and it is what catches a future double-count.
    const maxPossible = orders.filter(countsAsRevenue).reduce((a, o) => a + orderNetTotal(o), 0);
    expect(getOrderTotals(orders).gmvAgorot).toBeLessThanOrEqual(maxPossible);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. A seller's accrued balance. Reporting only — but a number the owner reads
//     about somebody else's money, so it gets the same treatment as one that moves.
// ─────────────────────────────────────────────────────────────────────────────

describe('a seller balance closes, and agrees with the seller\'s own tab', () => {
  const SELLERS = [
    { id: 'sel-a', name: 'A', email: 'a@x.com', passwordHash: '', tier: 'starter' as const, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'sel-b', name: 'B', email: 'b@x.com', passwordHash: '', tier: 'enterprise' as const, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'sel-none', name: 'N', email: 'n@x.com', passwordHash: '', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const STORES = [
    { id: 'st-1', slug: STORE, name: 'S1', sellerId: 'sel-a' },
    { id: 'st-2', slug: OTHER, name: 'S2', sellerId: 'sel-a' },
    { id: 'st-3', slug: 'inv-third', name: 'S3', sellerId: 'sel-b' },
  ];
  const REVENUE = new Map([
    [STORE, { totalRevenueAgorot: 123_457, monthRevenueAgorot: 1_000 }],
    [OTHER, { totalRevenueAgorot: 8_999, monthRevenueAgorot: 0 }],
    ['inv-third', { totalRevenueAgorot: 250_000, monthRevenueAgorot: 5_000 }],
  ]);

  it('the parts sum to the whole, at every level', () => {
    const balances = buildSellerBalances(SELLERS, STORES, REVENUE);
    for (const b of balances) {
      expectSameMoney(b.commissionAgorot + b.totalEarnedAgorot, b.grossRevenueAgorot, `${b.sellerId}: commission + earned vs gross`);
      expectSameMoney(b.stores.reduce((a, s) => a + s.totalEarnedAgorot, 0), b.totalEarnedAgorot, `${b.sellerId}: stores vs seller total`);
      expectSameMoney(b.stores.reduce((a, s) => a + s.grossRevenueAgorot, 0), b.grossRevenueAgorot, `${b.sellerId}: store gross vs seller gross`);
      for (const store of b.stores) {
        expectSameMoney(store.commissionAgorot + store.totalEarnedAgorot, store.grossRevenueAgorot, `${store.storeSlug}: closes`);
      }
    }
    const totals = platformTotals(balances);
    expectSameMoney(balances.reduce((a, b) => a + b.totalEarnedAgorot, 0), totals.totalEarnedAgorot, 'platform total vs seller rows');
    expectSameMoney(totals.commissionAgorot + totals.totalEarnedAgorot, totals.grossRevenueAgorot, 'platform totals close');
  });

  it('never reports a seller more than the mall took, or less than nothing', () => {
    // The bounds, not an example: a balance above gross would be the platform paying out money no
    // buyer ever spent, and a negative one would be a seller owing us for having sold something.
    for (const b of buildSellerBalances(SELLERS, STORES, REVENUE)) {
      expect(b.totalEarnedAgorot).toBeLessThanOrEqual(b.grossRevenueAgorot);
      expect(b.totalEarnedAgorot).toBeGreaterThanOrEqual(0);
      expect(b.commissionAgorot).toBeGreaterThanOrEqual(0);
    }
  });

  it('counts only the stores their owner actually owns', () => {
    const balances = buildSellerBalances(SELLERS, STORES, REVENUE);
    const byId = new Map(balances.map((b) => [b.sellerId, b]));
    expect(byId.get('sel-a')!.stores.map((s) => s.storeId)).toEqual(['st-1', 'st-2']);
    expect(byId.get('sel-b')!.stores.map((s) => s.storeId)).toEqual(['st-3']);
    // A seller with no stores is still a row, at zero — an absent row would read as "not loaded".
    expect(byId.get('sel-none')!.stores).toEqual([]);
    expect(byId.get('sel-none')!.totalEarnedAgorot).toBe(0);
    // And the platform total is every store's revenue, none double-counted.
    expectSameMoney(
      platformTotals(balances).grossRevenueAgorot,
      [...REVENUE.values()].reduce((a, r) => a + r.totalRevenueAgorot, 0),
      'balance gross vs the revenue map it came from',
    );
  });

  it('applies the seller\'s OWN tier, not one rate for everybody', () => {
    // Two sellers on different tiers is the case a single platform-wide percent gets wrong the
    // moment the second tier is sold — and it gets it wrong silently, in the platform's favour.
    const byId = new Map(buildSellerBalances(SELLERS, STORES, REVENUE).map((b) => [b.sellerId, b]));
    expect(byId.get('sel-a')!.commissionRate).toBe(commissionPercentForTier('starter'));
    expect(byId.get('sel-b')!.commissionRate).toBe(commissionPercentForTier('enterprise'));
    // An account with no tier recorded is the default tier, never zero commission.
    expect(byId.get('sel-none')!.commissionRate).toBe(commissionPercentForTier(undefined));
    expect(byId.get('sel-none')!.commissionRate).toBeGreaterThan(0);
  });

  it('is the same number the seller\'s own performance tab shows', () => {
    // Two surfaces, one fact: the admin's "יתרה למוכר/ת" and the seller's "net profit" are the
    // same subtraction, so they must not be able to disagree by an agora of rounding.
    const rate = commissionPercentForTier('starter');
    const sales = [
      makeOrder('bal-1', { items: [{ productId: 'p1', priceAgorot: 1999, qty: 3 }], shippingAgorot: 2500 }),
      makeOrder('bal-2', { items: [{ productId: 'p1', priceAgorot: 10000, qty: 1 }], shippingAgorot: 0, discount: { type: 'percent', value: 25, appliedAgorot: 2500 } }),
    ];
    const summary = buildPerformanceSummary(sales, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day', rate);
    const balances = buildSellerBalances(
      [SELLERS[0]!],
      [{ id: 'st-1', slug: STORE, name: 'S1', sellerId: 'sel-a' }],
      new Map([[STORE, { totalRevenueAgorot: summary.totalRevenueAgorot, monthRevenueAgorot: 0 }]]),
    );
    // Non-vacuous: two surfaces agreeing on zero would prove nothing, and the commission on this
    // revenue does not divide evenly, so it is a real rounding both sides have to make the same way.
    expect(summary.totalRevenueAgorot).toBeGreaterThan(0);
    expect((summary.totalRevenueAgorot * rate) % 100).not.toBe(0);
    expectSameMoney(balances[0]!.totalEarnedAgorot, summary.netProfitAgorot, 'admin balance vs seller net profit');
    expectSameMoney(balances[0]!.commissionAgorot, summary.platformCommissionAgorot, 'admin commission vs seller commission');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. One calendar. The bug that started this file.
// ─────────────────────────────────────────────────────────────────────────────

describe('reports bucket by the business calendar, not the runtime\'s', () => {
  // 2026-07-01 at 01:30 in Israel (UTC+3 in July) is 2026-06-30T22:30Z. Read in UTC
  // it is the 30th of JUNE — the previous day, and the previous MONTH.
  const justAfterMidnight = '2026-06-30T22:30:00.000Z';

  it('a sale just after local midnight belongs to the local day', () => {
    expect(businessDayISO(new Date(justAfterMidnight))).toBe('2026-07-01');
    expect(businessMonthKey(new Date(justAfterMidnight))).toBe('2026-07');
  });

  it('and therefore appears in "this month", not the one before', () => {
    const order = makeOrder('midnight', { items: [{ productId: 'p1', priceAgorot: 12000, qty: 1 }], createdAt: justAfterMidnight });
    const july = buildPerformanceSummary([order], EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(july.totalRevenueAgorot, 12_000, 'a 01:30 sale on the 1st counts in that month');
    expect(july.totalOrders).toBe(1);

    // And it is filed on the 1st, not the 30th of the previous month.
    const july1 = july.points.find((p) => p.key === '2026-07-01');
    expectSameMoney(july1?.revenueAgorot ?? 0, 12_000, 'bucketed onto the 1st');
  });

  it('a sale just before local midnight stays on the day that is ending', () => {
    // 2026-07-31T20:30Z is 23:30 on the 31st in Israel — still July.
    const order = makeOrder('lastminute', { items: [{ productId: 'p1', priceAgorot: 6000, qty: 1 }], createdAt: '2026-07-31T20:30:00.000Z' });
    expectSameMoney(buildPerformanceSummary([order], EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot, 6_000, 'late-night sale stays in July');
    expectSameMoney(buildPerformanceSummary([order], EMPTY_VIEW_STATS, STORE, '2026-08-01', '2026-08-31', 'day').totalRevenueAgorot, 0, 'and does not leak into August');
  });

  it('holds across a DST boundary', () => {
    // Israel leaves DST in late October. A date-arithmetic approach that adds
    // 24h-in-milliseconds drifts by an hour here; comparing business-day strings
    // does not, which is why the range filter works the way it does.
    const beforeDst = new Date('2026-10-24T21:30:00.000Z'); // 00:30 on the 25th, IDT (+3)
    const afterDst = new Date('2026-10-26T22:30:00.000Z');  // 00:30 on the 27th, IST (+2)
    expect(businessDayISO(beforeDst)).toBe('2026-10-25');
    expect(businessDayISO(afterDst)).toBe('2026-10-27');
  });

  it('the business timezone is stated, not inherited from the host', () => {
    // The failure this guards is silent: on a UTC production server "local time"
    // looks correct in every test run on a developer's Israeli laptop.
    expect(BUSINESS_TIMEZONE).toBe('Asia/Jerusalem');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Guard: the rules above must stay single-sourced.
// ─────────────────────────────────────────────────────────────────────────────

describe('the reporting modules keep using the shared definitions', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('no report derives a calendar day from toISOString()', () => {
    // The original bug, in one line. Axis enumeration goes through calendarDayISO;
    // order timestamps go through businessDayISO. A bare toISOString().slice here is
    // the exact shape of the regression.
    for (const file of ['src/lib/seller-performance.ts', 'src/lib/admin-stats.ts', 'src/lib/platform-performance.ts']) {
      expect(read(file), file).not.toMatch(/toISOString\(\)\s*\.slice/);
    }
  });

  it('no report hand-rolls its own "this month"', () => {
    for (const file of ['src/lib/seller-performance.ts', 'src/lib/admin-stats.ts', 'src/lib/platform-performance.ts']) {
      expect(read(file), file).not.toMatch(/getMonth\(\)/);
    }
  });

  it('no report hand-rolls money rounding', () => {
    // Every amount goes through lib/money.ts, so the agorot decision at the DB
    // migration is one edit rather than a hunt through every reducer.
    for (const file of ['src/lib/seller-performance.ts', 'src/lib/admin-stats.ts', 'src/lib/platform-performance.ts', 'src/pages/api/checkout.ts']) {
      expect(read(file), file).not.toMatch(/Math\.round\([^)]*\*\s*100\s*\)\s*\/\s*100/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The same rules, run over the STORED orders.
//
// This read `data/orders.json` until the module moved (DB_MIGRATION_PLAN.md §8). It follows the
// data rather than the file: the point was never the JSON, it was that these invariants also run
// over rows nobody wrote for a test — imported history, with every shape a year of drift left in
// it — instead of only over fixtures somebody thought of.
// ─────────────────────────────────────────────────────────────────────────────

describe('the stored orders satisfy the same invariants', () => {
  let live: Order[] = [];
  beforeAll(async () => {
    // `getAllOrders()` is gone (§3) — this reads the whole fixture through the module's own paged
    // reader instead, with a page big enough to hold it. The assertion below is what stops that
    // from quietly becoming "the first page satisfies the invariants".
    const page = await getAdminOrdersPage({}, 1, 10_000);
    expect(page.total, 'the audit must cover every stored order, not one page of them').toBe(page.orders.length);
    live = page.orders;
  });

  it('every stored order holds only non-negative, bounded amounts', () => {
    // Not a hypothetical: this is a standing audit of the data an admin is looking at right now.
    //
    // **The full money-closure identity is deliberately NOT asserted over this set.** These rows
    // are imported ILS-era history, and the test fixture carries the drift that history really
    // has (§7.3) — including an order whose own stored `totalAmount` never agreed with its parts
    // in ILS either. Demanding closure here would mean asserting that a year of legacy data is
    // arithmetically perfect, which it is not and never was; it is `reconcile.ts` that reports
    // those rows, on the live database, on every admin render. What IS asserted over the stored
    // set is everything that must hold regardless of where a row came from — no negative money,
    // no discount exceeding what it discounts, unique ids — plus the closure identity in full on
    // an order this codebase actually wrote, below.
    for (const o of live) assertStoredAmountsAreSane(o, 'stored orders');
  });

  it('an order this codebase writes closes on its own arithmetic, exactly', () => {
    // The other half of the split above, and the one that guards the code rather than the data:
    // no legacy slack, no tolerance, integer agorot in and out.
    const order = makeOrder('roundtrip', {
      items: [{ productId: 'p1', priceAgorot: 1999, qty: 3 }, { productId: 'p2', priceAgorot: 10, qty: 7 }],
      shippingAgorot: 2500,
      discount: { type: 'percent', value: 10, appliedAgorot: 613 },
    });
    assertOrderIsInternallyConsistent(order, 'round-trip');
  });

  it('every order id is unique', () => {
    // Duplicate ids would double-count in every report while looking like one order
    // in the dashboard list.
    const ids = live.map((o) => o.id);
    expect(new Set(ids).size, 'unique order ids').toBe(ids.length);
  });

  it('the admin GMV equals the sum of the per-store rows on the stored data too', () => {
    const rowSum = [...getStoreRevenueMap(live, MONTH).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0);
    expectSameMoney(getOrderTotals(live).gmvAgorot, rowSum, 'stored-data GMV reconciliation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. §3 — every number that MOVED into the database still equals the JavaScript
//    it moved out of.
//
// This is the section DB_MIGRATION_PLAN.md §3 required before the change could be called done:
// five admin surfaces that display money were rewritten from "read everything and compute in
// Node" to "let the database compute it", and every one of those numbers is one the owner reads
// as fact. A SUM in SQL and a `reduce` in JS agreeing is not obvious — they differ on rounding,
// on `bigint` arriving as a string, on which rows a LEFT JOIN keeps, and on which calendar
// decides a business day.
//
// Each pure twin below is kept for exactly this: it is the definition, it needs no database, and
// it is what lets these assertions say "the query still means what it meant" instead of
// "the query returns some number".
// ─────────────────────────────────────────────────────────────────────────────

describe('§3 — the queries agree with the JavaScript they replaced', () => {
  let stored: Order[] = [];
  let slugs: string[] = [];

  beforeAll(async () => {
    stored = (await getAdminOrdersPage({}, 1, 10_000)).orders;
    slugs = (await getAllStores()).map((s) => s.slug);
  });

  it('the platform headline: getPlatformOrderTotals === getOrderTotals', async () => {
    const fromDb = await getPlatformOrderTotals();
    const fromJs = getOrderTotals(stored);
    expect(fromDb.totalOrders, 'order count').toBe(fromJs.totalOrders);
    expect(fromDb.paidOrders, 'revenue-counting order count').toBe(fromJs.paidOrders);
    expectSameMoney(fromDb.gmvAgorot, fromJs.gmvAgorot, 'GMV');
  });

  it('revenue per store: getStoreRevenueBySlug === getStoreRevenueMap', async () => {
    // The month column is asked about with the SAME key both sides, because the month is a
    // parameter now — it used to be `new Date()` inside the JS, so the Overview card and the
    // Stores tab could be looking at two different months on the same render.
    const month = businessMonthKey(new Date());
    const fromDb = await getStoreRevenueBySlug(month);
    const fromJs = getStoreRevenueMap(stored, month);
    // Every slug either side knows about — a store missing from one map is exactly the drift.
    for (const slug of new Set([...fromDb.keys(), ...fromJs.keys()])) {
      expectSameMoney(fromDb.get(slug)?.totalRevenueAgorot ?? 0, fromJs.get(slug)?.totalRevenueAgorot ?? 0, `${slug} all-time`);
      expectSameMoney(fromDb.get(slug)?.monthRevenueAgorot ?? 0, fromJs.get(slug)?.monthRevenueAgorot ?? 0, `${slug} this month`);
    }
  });

  it('the GMV headline still equals the sum of the per-store rows — both sides from the DB', async () => {
    // The check `reconcile.ts` runs on every admin render, asserted here as an invariant: an
    // ungrouped aggregate against the sum of a grouped one. Two plans, one number.
    const totals = await getPlatformOrderTotals();
    const rows = await getStoreRevenueBySlug('');
    expectSameMoney([...rows.values()].reduce((a, r) => a + r.totalRevenueAgorot, 0), totals.gmvAgorot, 'DB GMV vs DB per-store rows');
  });

  it('open orders per store: the query === countOpenOrdersByStore', async () => {
    const fromDb = await getOpenOrderCountsByStore();
    const fromJs = countOpenOrdersByStore(stored);
    for (const slug of new Set([...fromDb.keys(), ...fromJs.keys()])) {
      expect(fromDb.get(slug) ?? 0, `${slug} open orders`).toBe(fromJs.get(slug) ?? 0);
    }
  });

  it('platform sales per store and per bucket: getPlatformSales === buildPlatformSales', async () => {
    for (const granularity of ['day', 'month'] as const) {
      const from = '2026-01-01';
      const to = '2026-12-31';
      const fromDb = await getPlatformSales(slugs, from, to, granularity, 5);
      const fromJs = buildPlatformSales(stored, slugs, from, to, granularity, 5);
      for (const slug of slugs) {
        const a = fromDb.byStore.get(slug)!;
        const b = fromJs.byStore.get(slug)!;
        expectSameMoney(a.totalRevenueAgorot, b.totalRevenueAgorot, `${slug} revenue (${granularity})`);
        expect(a.totalOrders, `${slug} orders (${granularity})`).toBe(b.totalOrders);
        // Bucket by bucket, so a whole-range total that happens to match while the CHART is wrong
        // cannot pass — that is the failure an admin sees and a total would hide.
        const keyed = (buckets: readonly { key: string; revenueAgorot: number; orders: number }[]) =>
          Object.fromEntries(buckets.map((x) => [x.key, [x.revenueAgorot, x.orders]]));
        expect(keyed(a.buckets), `${slug} buckets (${granularity})`).toEqual(keyed(b.buckets));
      }
      expect(fromDb.topProducts.map((p) => [p.productId, p.revenueAgorot, p.units]),
        `top products (${granularity})`).toEqual(fromJs.topProducts.map((p) => [p.productId, p.revenueAgorot, p.units]));
    }
  });

  it('the platform summary built from the query equals the one built from the orders', async () => {
    // One level up from the previous case: the numbers the Performance tab actually renders.
    const from = '2026-01-01';
    const to = '2026-12-31';
    const stores = slugs.map((slug) => ({ id: slug, slug, name: slug, commissionPercent: 10 }));
    const fromDb = buildPlatformPerformance(await getPlatformSales(slugs, from, to, 'month'), stores, NO_VIEWS, from, to, 'month');
    const fromJs = buildPlatformPerformance(buildPlatformSales(stored, slugs, from, to, 'month'), stores, NO_VIEWS, from, to, 'month');
    expectSameMoney(fromDb.summary.totalRevenueAgorot, fromJs.summary.totalRevenueAgorot, 'platform revenue');
    expectSameMoney(fromDb.summary.platformCommissionAgorot, fromJs.summary.platformCommissionAgorot, 'platform commission');
    expect(fromDb.summary.totalOrders).toBe(fromJs.summary.totalOrders);
    expect(fromDb.stores.map((r) => [r.slug, r.revenueAgorot, r.orders])).toEqual(fromJs.stores.map((r) => [r.slug, r.revenueAgorot, r.orders]));
  });

  it('the live reconciliation reaches the same verdict as the one over the orders', async () => {
    const fromDb = await reconcilePlatform(slugs);
    const fromJs = reconcileOrders(stored, slugs);
    expect(fromDb.checkedOrders, 'orders checked').toBe(fromJs.checkedOrders);
    expect(fromDb.clean, 'clean verdict').toBe(fromJs.clean);
    // Compared as sets of (check, subject, drift): the two routes are free to report in a
    // different ORDER, and requiring one would be asserting an implementation detail.
    const key = (d: { check: string; subject?: string; drift: number }) => `${d.check}|${d.subject ?? ''}|${d.drift}`;
    expect(new Set(fromDb.discrepancies.map(key))).toEqual(new Set(fromJs.discrepancies.map(key)));
  });

  // A reconciler that never fires is indistinguishable from one that is broken (the rule
  // tests/reporting-fuzz.test.ts states), and a fixture that happens to be healthy makes every
  // check here vacuous. So each check is broken deliberately, one at a time, and required to be
  // named by BOTH routes — then the row is put back.
  const damage: Array<{ what: string; break_: string; heal: string; severity: 'error' | 'warning' }> = [
    {
      what: 'the line items stop matching the stored subtotal',
      break_: 'UPDATE order_stores SET subtotal_agorot = subtotal_agorot + 1 WHERE order_id = $1 AND store_slug = $2',
      heal: 'UPDATE order_stores SET subtotal_agorot = subtotal_agorot - 1 WHERE order_id = $1 AND store_slug = $2',
      severity: 'error',
    },
    {
      what: 'a discount exceeds what it discounts',
      // The TYPE goes on too, not just the amount: `toOrder` only rebuilds a discount object when
      // there is a type, so an amount without one is a row shape the seller edit path cannot write
      // — and asserting against it would be asserting about data that does not occur.
      break_: "UPDATE order_stores SET discount_type = 'percent', discount_percent = 99, discount_applied_agorot = subtotal_agorot + 100 WHERE order_id = $1 AND store_slug = $2",
      heal: 'UPDATE order_stores SET discount_type = NULL, discount_percent = NULL, discount_applied_agorot = 0 WHERE order_id = $1 AND store_slug = $2',
      severity: 'warning',
    },
  ];

  for (const { what, break_, heal, severity } of damage) {
    it(`the reconciliation fires when ${what}, through the query as well`, async () => {
      const victim = stored.find((o) => Object.keys(o.storeSubtotals ?? {}).length > 0)!;
      const slug = Object.keys(victim.storeSubtotals)[0]!;
      await query(break_, [victim.id, slug]);
      try {
        const fromDb = await reconcilePlatform(slugs);
        const fromJs = reconcileOrders((await getAdminOrdersPage({}, 1, 10_000)).orders, slugs);
        for (const [route, report] of [['query', fromDb], ['pure', fromJs]] as const) {
          expect(report.clean, `${route}: damaged data must not read as clean`).toBe(false);
          expect(
            report.discrepancies.some((d) => d.severity === severity && d.subject?.includes(victim.id.slice(0, 8))),
            `${route}: the damaged order must be named`,
          ).toBe(true);
        }
      } finally {
        await query(heal, [victim.id, slug]);
      }
    });
  }

  it('the funnel counts a seller by their LIVE stores — a deleted one does not qualify them', async () => {
    // `getAllStores` filters `deleted_at`, so the JS this replaced never saw a deleted store. The
    // fixture has none, which would have left that half of the query asserting nothing.
    const store = (await getAllStores()).find((s) => s.slug === 'keramika')!;
    const before = await getSellerFunnel();
    await query('UPDATE stores SET deleted_at = now() WHERE id = $1', [store.id]);
    try {
      const after = await getSellerFunnel();
      expect(after.withStore, 'a deleted store must not keep counting').toBeLessThan(before.withStore);
    } finally {
      await query('UPDATE stores SET deleted_at = NULL WHERE id = $1', [store.id]);
    }
  });

  it('the seller onboarding funnel: the four counts === buildSellerFunnel', async () => {
    const fromDb = await getSellerFunnel();
    const fromJs = buildSellerFunnel(
      await getAllSellers(),
      await getAllStores(),
      [...(await getProductsByStoreIds((await getAllStores()).map((s) => s.id))).entries()]
        .flatMap(([storeId, list]) => list.map(() => ({ storeId }))),
      stored,
      fromDb.registerViews,
    );
    expect(fromDb).toEqual(fromJs);
  });

  it('product counts per store: the GROUP BY === counting the rows', async () => {
    const stores = await getAllStores();
    const counts = await getProductCountsByStore(stores.map((s) => s.id));
    const products = await getProductsByStoreIds(stores.map((s) => s.id));
    for (const store of stores) {
      const list = products.get(store.id) ?? [];
      expect(counts.get(store.id)?.total ?? 0, `${store.slug} total`).toBe(list.length);
      expect(counts.get(store.id)?.visible ?? 0, `${store.slug} visible`).toBe(list.filter(isProductVisible).length);
      expect(counts.get(store.id)?.unblocked ?? 0, `${store.slug} unblocked`).toBe(list.filter((p) => !p.blocked).length);
    }
  });

  it('campaign totals: the COUNT/SUM === campaignTotalsOf', async () => {
    // Not range-scoped on either side — "how many exist and what is committed now" is a
    // forward-looking number, which is exactly why it stopped being counted off a narrowed list.
    const wide = await getCampaignsInRange('2000-01-01', '2100-01-01');
    expect(await getCampaignTotals()).toEqual(campaignTotalsOf(wide));
  });

  it('subscription accrual: the GROUP BY bills what the per-seller arithmetic billed', async () => {
    // The tier rollup replaced a loop over every seller. Same money: the fee is a property of the
    // tier and the only per-seller input is how many days of the range the account existed for.
    const from = '2026-07-01';
    const to = '2026-07-30';
    const tiers = await getSubscriptionAccrual(from, to);
    const sellers = await getAllSellers();
    const billable = (createdAt: string): number => {
      const signup = createdAt.slice(0, 10);
      if (signup > to) return 0;
      return daysInRangeInclusive(signup > from ? signup : from, to);
    };
    expect(tiers.reduce((a, t) => a + t.subscribers, 0), 'subscriber count')
      .toBe(sellers.filter((s) => billable(s.createdAt) > 0).length);
    expect(tiers.reduce((a, t) => a + t.billableDays, 0), 'billable days')
      .toBe(sellers.reduce((a, s) => a + billable(s.createdAt), 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. §8 stage 4a — nothing the SCHEDULER runs may move money or stock.
//
// Three jobs now run on a timer, with nobody watching (DB_MIGRATION_PLAN.md §8, migration 0007).
// Two of them are allowed to write: the campaign sweep flips campaign statuses, and the feed pull
// sets product stock from a seller's external system. Neither has any business changing an amount.
//
// The distinction this section pins is precisely the one an unattended job blurs. A sweep that
// paused a campaign is doing its job; a sweep that also re-budgeted it, or archived it instead of
// pausing it, is destroying a number the seller committed and the owner reports — and it would do
// so on a timer, quietly, at every store at once. The same for stock: no job may move a unit that
// no feed asked to move.
//
// The double-run half of the standing rule (a job run twice = a job run once) is per-job and lives
// in `tests/jobs-scheduler.test.ts`; what belongs here is the cross-surface statement.
// ─────────────────────────────────────────────────────────────────────────────

describe('§8 — the scheduled jobs move statuses, never amounts', () => {
  interface Ledger { orders: number; gmv: number; campaigns: number; budget: number; stock: number }

  async function ledger(): Promise<Ledger> {
    const totals = await getPlatformOrderTotals();
    // Every campaign row, archived or not: the sweep is allowed to archive a finished campaign, and
    // an archive that quietly dropped the row (or its budget) would be invisible to a live-only count.
    const [money] = (await query<{ campaigns: number; budget: number }>(
      'SELECT COUNT(*)::bigint AS campaigns, COALESCE(SUM(monthly_budget_agorot), 0)::bigint AS budget FROM ad_campaigns',
    )).rows;
    const [inventory] = (await query<{ stock: number }>(
      'SELECT COALESCE(SUM(stock), 0)::bigint AS stock FROM store_products',
    )).rows;
    return {
      orders: totals.totalOrders, gmv: totals.gmvAgorot,
      campaigns: money!.campaigns, budget: money!.budget, stock: inventory!.stock,
    };
  }

  it('a full pass over every job leaves the platform totals exactly where they were', async () => {
    // The feed pull is the one job that reaches somebody else's server, and no store in the fixture
    // has a feed URL — so it is a genuine no-op here rather than one arranged by the test. Asserting
    // that keeps it honest: the day a fixture store gains a feed URL, this says so instead of
    // silently making an outbound request from the test suite.
    expect(await getStoresWithFeedUrl()).toEqual([]);

    const before = await ledger();
    for (const job of JOBS) await job.run();
    const afterOnce = await ledger();
    // Twice, because the lease reduces double-runs and does not rule them out. A job that moved a
    // number by a little on each pass would look stable in a single-run test and drift in production.
    for (const job of JOBS) await job.run();
    const afterTwice = await ledger();

    expect(afterOnce, 'after one pass').toEqual(before);
    expect(afterTwice, 'after a second pass').toEqual(before);
  });

  it('the sweep may change a campaign\'s status and nothing else about it', async () => {
    const columns = 'id, store_id, scope, platform, monthly_budget_agorot, duration_days, created_at';
    const snapshot = async (): Promise<string> => JSON.stringify(
      (await query(`SELECT ${columns} FROM ad_campaigns ORDER BY id`)).rows,
    );

    const before = await snapshot();
    await JOBS.find((j) => j.name === 'campaign-sweep')!.run();
    // Status, pausedReason, pausedAt and archivedAt are deliberately NOT in the column list — those
    // are what the sweep exists to write. Everything the seller decided when they launched is.
    expect(await snapshot()).toBe(before);
  });
});
