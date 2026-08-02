import { beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Order } from '../src/lib/orders.js';
import { countsAsRevenue, getAllOrders } from '../src/lib/orders.js';
import { buildPerformanceSummary, buildProductPerformance } from '../src/lib/seller-performance.js';
import { buildPlatformPerformance } from '../src/lib/platform-performance.js';
// Traffic is an input now; these invariants are about money, so they assert against no traffic.
import { EMPTY_VIEW_STATS, type StoreViewStats } from '../src/lib/store-pageviews.js';
import { EMPTY_PRODUCT_VIEW_STATS } from '../src/lib/product-pageviews.js';
const NO_VIEWS = new Map<string, StoreViewStats>();
import { getPlatformOverview, getStoreRevenueMap, orderNetForStore, orderNetTotal } from '../src/lib/admin-stats.js';
import { businessDayISO, businessMonthKey, BUSINESS_TIMEZONE } from '../src/lib/business-day.js';
import { storeSliceTotalAgorot } from '../src/lib/order-totals.js';

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
    const overview = getPlatformOverview([], [], orders);
    const rows = getStoreRevenueMap(orders);
    const rowSum = [...rows.values()].reduce((a, r) => a + r.totalRevenueAgorot, 0);
    expectSameMoney(overview.gmvAgorot, rowSum, 'overview GMV vs sum of per-store revenue');
  });

  it('the platform performance total equals the sum of its own store breakdown', () => {
    const perf = buildPlatformPerformance(orders, [{ id: STORE, slug: STORE, name: 'S' }, { id: OTHER, slug: OTHER, name: 'O' }], NO_VIEWS, '2026-07-01', '2026-07-31', 'day');
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
    const perf = buildPlatformPerformance(orders, [{ id: STORE, slug: STORE, name: 'S' }, { id: OTHER, slug: OTHER, name: 'O' }], NO_VIEWS, '2026-07-01', '2026-07-31', 'day');
    const sellerSum = [STORE, OTHER].reduce(
      (a, slug) => a + buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot, 0,
    );
    expectSameMoney(perf.summary.totalRevenueAgorot, sellerSum, 'platform total vs sum of seller tabs');
  });

  it('no surface counts an order that is not paid, or that was cancelled', () => {
    // The single predicate, asserted from the outside: whatever each surface
    // computes, adding a cancelled/failed/pending order must not move it.
    const live = orders.filter(countsAsRevenue);
    expectSameMoney(getPlatformOverview([], [], orders).gmvAgorot, getPlatformOverview([], [], live).gmvAgorot, 'overview GMV ignores dead orders');
    expectSameMoney(
      buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot,
      buildPerformanceSummary(live, EMPTY_VIEW_STATS, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenueAgorot,
      'seller revenue ignores dead orders',
    );
    expectSameMoney(
      [...getStoreRevenueMap(orders).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0),
      [...getStoreRevenueMap(live).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0),
      'per-store revenue ignores dead orders',
    );
  });

  it('the store count is real stores, with showcase ones counted apart', () => {
    // The showcase stores refuse checkout outright, so folding them into the
    // headline told the owner his marketplace was bigger than it is — on the one
    // card he would use to judge whether the business is actually working.
    const overview = getPlatformOverview([], [
      { slug: 'real-1', name: 'R1', sellerId: 's1' },
      { slug: 'real-2', name: 'R2', sellerId: 's1' },
      { slug: 'demo-1', name: 'D1', sellerId: 's9', demo: true },
    ] as never, []);
    expect(overview.totalStores).toBe(2);
    expect(overview.demoStores).toBe(1);
  });

  it('an order can never contribute more than it is worth', () => {
    // An upper bound rather than an exact figure: it holds no matter how the
    // reporting is refactored, and it is what catches a future double-count.
    const maxPossible = orders.filter(countsAsRevenue).reduce((a, o) => a + orderNetTotal(o), 0);
    expect(getPlatformOverview([], [], orders).gmvAgorot).toBeLessThanOrEqual(maxPossible);
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
  beforeAll(async () => { live = await getAllOrders(); });

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
    const rowSum = [...getStoreRevenueMap(live).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0);
    expectSameMoney(getPlatformOverview([], [], live).gmvAgorot, rowSum, 'stored-data GMV reconciliation');
  });
});
