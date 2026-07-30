import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Order } from '../src/lib/orders.js';
import { countsAsRevenue } from '../src/lib/orders.js';
import { buildPerformanceSummary, buildProductPerformance } from '../src/lib/seller-performance.js';
import { buildPlatformPerformance } from '../src/lib/platform-performance.js';
import { getPlatformOverview, getStoreRevenueMap, orderNetForStore, orderNetTotal } from '../src/lib/admin-stats.js';
import { businessDayISO, businessMonthKey, BUSINESS_TIMEZONE } from '../src/lib/business-day.js';
import { roundMoney } from '../src/lib/money.js';

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
  items: Array<{ productId: string; price: number; qty: number; storeSlug?: string }>;
  shipping?: number;
  discount?: { type: 'percent' | 'amount'; value: number; applied: number };
  createdAt?: string;
  over?: OrderOverrides;
}): Order {
  const items = opts.items.map((i) => ({
    productId: i.productId,
    productName: `name-${i.productId}`,
    productSlug: `slug-${i.productId}`,
    storeSlug: i.storeSlug ?? STORE,
    storeName: 'S',
    price: i.price,
    qty: i.qty,
  }));
  const shipping = opts.shipping ?? 0;
  const bySlug = new Map<string, number>();
  for (const i of items) bySlug.set(i.storeSlug, roundMoney((bySlug.get(i.storeSlug) ?? 0) + i.price * i.qty));

  const storeSubtotals: Record<string, { storeName: string; subtotal: number; shipping: number; discount?: typeof opts.discount }> = {};
  for (const [slug, subtotal] of bySlug) {
    storeSubtotals[slug] = { storeName: 'S', subtotal, shipping, ...(slug === STORE && opts.discount ? { discount: opts.discount } : {}) };
  }
  const totalAmount = roundMoney(
    Object.values(storeSubtotals).reduce((s, st) => s + st.subtotal + st.shipping - (st.discount?.applied ?? 0), 0),
  );

  return {
    id,
    buyerName: 'B', buyerEmail: 'b@x.test', buyerPhone: '0500000000',
    buyerAddress: { city: 'C', street: 'S' },
    items,
    storeSubtotals,
    shippingAmount: shipping,
    totalAmount,
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
function expectSameMoney(actual: number, expected: number, label: string): void {
  expect(roundMoney(actual), label).toBe(roundMoney(expected));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. An order's own arithmetic must close.
// ─────────────────────────────────────────────────────────────────────────────

/** Reusable so the same rules run over fixtures AND over the real file below. */
function assertOrderIsInternallyConsistent(o: Order, where: string): void {
  const label = `${where} order ${o.id}`;

  // The line items must account for exactly the store's subtotal. If they don't,
  // some path edited one without the other and the seller's product breakdown will
  // never add up to their revenue headline.
  for (const [slug, sub] of Object.entries(o.storeSubtotals)) {
    const fromItems = roundMoney(
      o.items.filter((i) => i.storeSlug === slug).reduce((s, i) => s + i.price * i.qty, 0),
    );
    expectSameMoney(sub.subtotal, fromItems, `${label} / ${slug}: subtotal vs sum of its line items`);
  }

  // totalAmount is the buyer-facing number. It must equal net + shipping across
  // every store on the order — the identity that lets the admin GMV headline and
  // the per-store rows reconcile.
  const expectedTotal = roundMoney(
    Object.entries(o.storeSubtotals).reduce((s, [slug, sub]) => s + orderNetForStore(o, slug) + sub.shipping, 0),
  );
  expectSameMoney(o.totalAmount, expectedTotal, `${label}: totalAmount vs sum(net + shipping)`);

  // No negative money anywhere, and a discount can never exceed what it discounts.
  expect(o.totalAmount, `${label}: totalAmount is not negative`).toBeGreaterThanOrEqual(0);
  for (const [slug, sub] of Object.entries(o.storeSubtotals)) {
    expect(sub.subtotal, `${label} / ${slug}: subtotal is not negative`).toBeGreaterThanOrEqual(0);
    expect(sub.shipping, `${label} / ${slug}: shipping is not negative`).toBeGreaterThanOrEqual(0);
    const applied = sub.discount?.applied ?? 0;
    expect(applied, `${label} / ${slug}: discount is not negative`).toBeGreaterThanOrEqual(0);
    expect(applied, `${label} / ${slug}: discount does not exceed subtotal + shipping`)
      .toBeLessThanOrEqual(roundMoney(sub.subtotal + sub.shipping));
  }
  for (const i of o.items) {
    expect(i.price, `${label}: item ${i.productId} price is not negative`).toBeGreaterThanOrEqual(0);
    expect(i.qty, `${label}: item ${i.productId} qty is a positive integer`).toBeGreaterThan(0);
    expect(Number.isInteger(i.qty), `${label}: item ${i.productId} qty is a whole number`).toBe(true);
  }

  // Every stored amount is already in agorot. A value that fails this arrived from
  // an unrounded `+=` somewhere and will show up in a CSV export or be handed to a
  // payment processor with twelve decimal places.
  const amounts: Array<[number, string]> = [
    [o.totalAmount, 'totalAmount'],
    [o.shippingAmount, 'shippingAmount'],
    ...Object.entries(o.storeSubtotals).flatMap(([slug, sub]): Array<[number, string]> => [
      [sub.subtotal, `${slug}.subtotal`],
      [sub.shipping, `${slug}.shipping`],
      [sub.discount?.applied ?? 0, `${slug}.discount.applied`],
    ]),
    ...o.items.map((i): [number, string] => [i.price, `item ${i.productId} price`]),
  ];
  for (const [value, name] of amounts) {
    expectSameMoney(value, value, `${label}: ${name} is stored rounded to agorot`);
  }
}

describe('every order closes on its own arithmetic', () => {
  it('holds for a plain order', () => {
    assertOrderIsInternallyConsistent(makeOrder('a', { items: [{ productId: 'p1', price: 19.99, qty: 3 }], shipping: 25 }), 'fixture');
  });

  it('holds for a discounted, multi-store, multi-line order', () => {
    assertOrderIsInternallyConsistent(makeOrder('b', {
      items: [
        { productId: 'p1', price: 33.33, qty: 3 },
        { productId: 'p2', price: 0.1, qty: 7 },
        { productId: 'p3', price: 12.5, qty: 1, storeSlug: OTHER },
      ],
      shipping: 19.9,
      discount: { type: 'percent', value: 10, applied: 12.01 },
    }), 'fixture');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A report's parts must sum to its whole.
// ─────────────────────────────────────────────────────────────────────────────

describe('the seller performance summary reconciles with itself', () => {
  const orders = [
    makeOrder('o1', { items: [{ productId: 'p1', price: 19.99, qty: 3 }], shipping: 25, createdAt: '2026-07-02T09:00:00.000Z' }),
    makeOrder('o2', { items: [{ productId: 'p2', price: 0.1, qty: 7 }], shipping: 0, createdAt: '2026-07-11T09:00:00.000Z' }),
    makeOrder('o3', {
      items: [{ productId: 'p1', price: 19.99, qty: 1 }, { productId: 'p3', price: 250, qty: 2 }],
      shipping: 19.9,
      discount: { type: 'amount', value: 40, applied: 40 },
      createdAt: '2026-07-20T09:00:00.000Z',
    }),
  ];

  it('the daily bars add up to the headline revenue', () => {
    const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(s.points.reduce((a, p) => a + p.revenue, 0), s.totalRevenue, 'sum of day buckets vs totalRevenue');
    expect(s.points.reduce((a, p) => a + p.orders, 0)).toBe(s.totalOrders);
  });

  it('the monthly bars add up to the same headline as the daily ones', () => {
    // Same window, different bucket size. If these disagree, one granularity is
    // dropping or double-counting orders at a boundary.
    const byDay = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day');
    const byMonth = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'month');
    expectSameMoney(byMonth.totalRevenue, byDay.totalRevenue, 'month total vs day total');
    expect(byMonth.totalOrders).toBe(byDay.totalOrders);
    expectSameMoney(byMonth.points.reduce((a, p) => a + p.revenue, 0), byMonth.totalRevenue, 'sum of month buckets');
  });

  it('commission plus net profit equals revenue, and neither escapes its bounds', () => {
    for (const rate of [0, 10, 10.25, 12, 100]) {
      const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day', rate);
      expectSameMoney(s.platformCommission + s.netProfit, s.totalRevenue, `commission + net at ${rate}%`);
      expect(s.platformCommission, `commission at ${rate}% is not negative`).toBeGreaterThanOrEqual(0);
      expect(s.platformCommission, `commission at ${rate}% never exceeds revenue`).toBeLessThanOrEqual(s.totalRevenue);
      expect(s.netProfit, `net profit at ${rate}% is not negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('the product breakdown accounts for revenue plus exactly the discounts given', () => {
    // topProducts is GROSS (per line item); totalRevenue is NET (after the
    // order-level discount). The gap between them must be the discounts and nothing
    // else — otherwise the "leading products" list is quietly built from a different
    // set of orders than the headline above it.
    const s = buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day', 0, 0);
    const gross = s.topProducts.reduce((a, p) => a + p.revenue, 0);
    const discounts = orders
      .filter(countsAsRevenue)
      .reduce((a, o) => a + (o.storeSubtotals[STORE]?.discount?.applied ?? 0), 0);
    expectSameMoney(gross, s.totalRevenue + discounts, 'gross product revenue vs net revenue + discounts');
  });

  it('a single product drill-down reconciles with its own bars', () => {
    const p = buildProductPerformance(orders, STORE, 'p1', '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(p.points.reduce((a, x) => a + x.revenue, 0), p.totalRevenue, 'product day buckets vs its total');
    expect(p.points.reduce((a, x) => a + x.units, 0)).toBe(p.totalUnits);
    expect(p.totalUnits).toBe(4); // 3 from o1 + 1 from o3
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Two surfaces describing the same money must produce the same number.
// ─────────────────────────────────────────────────────────────────────────────

describe('the admin surfaces reconcile with each other', () => {
  const orders = [
    makeOrder('o1', { items: [{ productId: 'p1', price: 19.99, qty: 3 }], shipping: 25 }),
    makeOrder('o2', { items: [{ productId: 'p2', price: 5.55, qty: 9, storeSlug: OTHER }], shipping: 19.9 }),
    makeOrder('o3', { items: [{ productId: 'p1', price: 100, qty: 1 }], shipping: 0, discount: { type: 'percent', value: 25, applied: 25 } }),
    makeOrder('cancelled', { items: [{ productId: 'p1', price: 999, qty: 5 }], over: { shippingStatus: 'cancelled' } }),
    makeOrder('failed', { items: [{ productId: 'p1', price: 777, qty: 5 }], over: { paymentStatus: 'failed' } }),
    makeOrder('pending', { items: [{ productId: 'p1', price: 555, qty: 5 }], over: { paymentStatus: 'pending' } }),
  ];

  it('the GMV headline equals the sum of the per-store rows', () => {
    // These are two different code paths over the same orders, on two different
    // admin tabs. The headline used to sum `order.totalAmount` (shipping included,
    // discounts ignored) while the rows summed net subtotals, so the two could never
    // be made to agree by any amount of staring at them.
    const overview = getPlatformOverview([], [], orders);
    const rows = getStoreRevenueMap(orders);
    const rowSum = [...rows.values()].reduce((a, r) => a + r.totalRevenue, 0);
    expectSameMoney(overview.gmv, rowSum, 'overview GMV vs sum of per-store revenue');
  });

  it('the platform performance total equals the sum of its own store breakdown', () => {
    const perf = buildPlatformPerformance(orders, [{ slug: STORE, name: 'S' }, { slug: OTHER, name: 'O' }], '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(
      perf.stores.reduce((a, r) => a + r.revenue, 0),
      perf.summary.totalRevenue,
      'sum of breakdown rows vs platform total',
    );
    expectSameMoney(perf.summary.points.reduce((a, p) => a + p.revenue, 0), perf.summary.totalRevenue, 'platform bars vs platform total');
  });

  it('the platform total equals what each store\'s own seller tab reports', () => {
    // The number the owner sees must be the number the sellers see, added up. A
    // platform aggregate computed by its own second implementation is the classic
    // place for the two to drift.
    const perf = buildPlatformPerformance(orders, [{ slug: STORE, name: 'S' }, { slug: OTHER, name: 'O' }], '2026-07-01', '2026-07-31', 'day');
    const sellerSum = [STORE, OTHER].reduce(
      (a, slug) => a + buildPerformanceSummary(orders, slug, '2026-07-01', '2026-07-31', 'day').totalRevenue, 0,
    );
    expectSameMoney(perf.summary.totalRevenue, sellerSum, 'platform total vs sum of seller tabs');
  });

  it('no surface counts an order that is not paid, or that was cancelled', () => {
    // The single predicate, asserted from the outside: whatever each surface
    // computes, adding a cancelled/failed/pending order must not move it.
    const live = orders.filter(countsAsRevenue);
    expectSameMoney(getPlatformOverview([], [], orders).gmv, getPlatformOverview([], [], live).gmv, 'overview GMV ignores dead orders');
    expectSameMoney(
      buildPerformanceSummary(orders, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenue,
      buildPerformanceSummary(live, STORE, '2026-07-01', '2026-07-31', 'day').totalRevenue,
      'seller revenue ignores dead orders',
    );
    expectSameMoney(
      [...getStoreRevenueMap(orders).values()].reduce((a, r) => a + r.totalRevenue, 0),
      [...getStoreRevenueMap(live).values()].reduce((a, r) => a + r.totalRevenue, 0),
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
    const maxPossible = roundMoney(orders.filter(countsAsRevenue).reduce((a, o) => a + orderNetTotal(o), 0));
    expect(getPlatformOverview([], [], orders).gmv).toBeLessThanOrEqual(maxPossible);
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
    const order = makeOrder('midnight', { items: [{ productId: 'p1', price: 120, qty: 1 }], createdAt: justAfterMidnight });
    const july = buildPerformanceSummary([order], STORE, '2026-07-01', '2026-07-31', 'day');
    expectSameMoney(july.totalRevenue, 120, 'a 01:30 sale on the 1st counts in that month');
    expect(july.totalOrders).toBe(1);

    // And it is filed on the 1st, not the 30th of the previous month.
    const july1 = july.points.find((p) => p.key === '2026-07-01');
    expectSameMoney(july1?.revenue ?? 0, 120, 'bucketed onto the 1st');
  });

  it('a sale just before local midnight stays on the day that is ending', () => {
    // 2026-07-31T20:30Z is 23:30 on the 31st in Israel — still July.
    const order = makeOrder('lastminute', { items: [{ productId: 'p1', price: 60, qty: 1 }], createdAt: '2026-07-31T20:30:00.000Z' });
    expectSameMoney(buildPerformanceSummary([order], STORE, '2026-07-01', '2026-07-31', 'day').totalRevenue, 60, 'late-night sale stays in July');
    expectSameMoney(buildPerformanceSummary([order], STORE, '2026-08-01', '2026-08-31', 'day').totalRevenue, 0, 'and does not leak into August');
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
// 6. The same rules, run over the real file.
// ─────────────────────────────────────────────────────────────────────────────

describe('the live data/orders.json satisfies the same invariants', () => {
  const ORDERS_PATH = path.join(process.cwd(), 'data/orders.json');
  let live: Order[] = [];
  try { live = JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8')) as Order[]; } catch { live = []; }

  it('every stored order closes on its own arithmetic', () => {
    // Not a hypothetical: this is a standing audit of the data an admin is looking
    // at right now. A hand-edited file, or an order written by a past bug, fails
    // here instead of silently sitting inside a revenue total.
    for (const o of live) assertOrderIsInternallyConsistent(o, 'data/orders.json');
  });

  it('every order id is unique', () => {
    // Duplicate ids would double-count in every report while looking like one order
    // in the dashboard list.
    const ids = live.map((o) => o.id);
    expect(new Set(ids).size, 'unique order ids').toBe(ids.length);
  });

  it('the admin GMV equals the sum of the per-store rows on the real data too', () => {
    const rowSum = [...getStoreRevenueMap(live).values()].reduce((a, r) => a + r.totalRevenue, 0);
    expectSameMoney(getPlatformOverview([], [], live).gmv, rowSum, 'real-data GMV reconciliation');
  });
});
