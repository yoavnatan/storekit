import { describe, it, expect } from 'vitest';
import type { Order } from '../src/lib/orders.js';
import { countsAsRevenue } from '../src/lib/orders.js';
import { buildPerformanceSummary, buildProductPerformance, pickGranularity } from '../src/lib/seller-performance.js';
import { buildPlatformPerformance, buildPlatformSales } from '../src/lib/platform-performance.js';
// Traffic is an input to the reporting builders now; every property asserted below is about money
// and order counts, so these pass none. See platform-performance.test.ts for why that is a gain.
import { EMPTY_VIEW_STATS, type StoreViewStats } from '../src/lib/store-pageviews.js';
import { EMPTY_PRODUCT_VIEW_STATS } from '../src/lib/product-pageviews.js';
const NO_VIEWS = new Map<string, StoreViewStats>();
import { getOrderTotals, getStoreRevenueMap, orderNetTotal } from '../src/lib/admin-stats.js';
import { reconcileOrders } from '../src/lib/reconcile.js';
import { toAgorot } from '../src/lib/money.js';
import { businessDayISO } from '../src/lib/business-day.js';

/** The business month `getStoreRevenueMap`'s month column is asked about. These assertions are
 *  about the ALL-TIME column, so the month is a constant that no clock decides. */
const MONTH = '2026-01';


/**
 * Property-based fuzzing over the reporting layer.
 *
 * The invariants in reporting-invariants.test.ts are checked against orders a person
 * wrote, which means they are checked against the situations that person thought of.
 * This file generates thousands of orders instead — awkward prices, zero-value lines,
 * multi-store carts, discounts that swallow the whole subtotal, timestamps sitting on
 * midnight and on month boundaries, every payment/shipping status combination — and
 * asserts the same properties survive all of them.
 *
 * That is the point: it explores the input space nobody enumerated. A bug that only
 * appears when a percent discount lands on a price ending in .005, in a month with a
 * DST change, does not need anyone to have imagined it.
 *
 * The generator is SEEDED and deterministic. A failure is reproducible from the seed
 * printed in the assertion label rather than being a flake that vanishes on re-run.
 */

/** Small deterministic PRNG (mulberry32) — Math.random would make failures unrepeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STORES = ['fz-a', 'fz-b', 'fz-c'];
const PAYMENT: Order['paymentStatus'][] = ['pending', 'paid', 'failed'];
const SHIPPING: Order['shippingStatus'][] = ['pending', 'processing', 'ready', 'shipped', 'delivered', 'cancelled'];

/** Prices chosen to be hostile to floating point, not to be realistic. They are ILS here on
 *  purpose — the seller types ILS — and cross into agorot through `toAgorot`, which is the one
 *  conversion in the pipeline that can still lose an agora. Everything downstream of it is
 *  integer arithmetic, so this fuzzer now proves the BOUNDARY is right rather than that the
 *  rounding after every addition was. */
const NASTY_PRICES = [0, 0.01, 0.1, 0.05, 19.99, 33.33, 0.145, 1 / 3, 99.995, 1234.56, 7.7, 250];

function makeFuzzOrder(id: string, rand: () => number): Order {
  const itemCount = 1 + Math.floor(rand() * 4);
  const items = Array.from({ length: itemCount }, (_, i) => {
    const storeSlug = STORES[Math.floor(rand() * STORES.length)]!;
    return {
      productId: `p${Math.floor(rand() * 5)}`,
      productName: 'P',
      productSlug: 'p',
      storeSlug,
      storeName: 'S',
      priceAgorot: toAgorot(NASTY_PRICES[Math.floor(rand() * NASTY_PRICES.length)]!),
      qty: 1 + Math.floor(rand() * 4),
      ...(i === 0 && rand() < 0.3 ? { selectedVariants: { size: 'M' } } : {}),
    };
  });

  // Subtotals built the way checkout builds them, so the fixtures are the shape the
  // real code produces rather than an idealised one.
  const subtotalBySlug = new Map<string, number>();
  for (const i of items) subtotalBySlug.set(i.storeSlug, (subtotalBySlug.get(i.storeSlug) ?? 0) + i.priceAgorot * i.qty);

  const storeSubtotals: Order['storeSubtotals'] = {};
  let shippingTotal = 0;
  for (const [slug, subtotal] of subtotalBySlug) {
    const shipping = rand() < 0.3 ? 0 : toAgorot([19.9, 25, 35][Math.floor(rand() * 3)]!);
    shippingTotal += shipping;
    let discount: Order['storeSubtotals'][string]['discount'];
    if (rand() < 0.35) {
      // Base is the subtotal, matching the orders API. It used to be
      // subtotal + shipping here too, which is how this fuzzer surfaced the negative
      // revenue bug in the first place: a 100% discount left `subtotal − (subtotal +
      // shipping)` behind.
      const base = subtotal;
      // Includes 100% on purpose — a discount that consumes the entire order is a
      // real seller action and a classic place for a division or a sign to go wrong.
      const type = rand() < 0.5 ? 'percent' as const : 'amount' as const;
      const value = type === 'percent' ? [5, 10, 33, 100][Math.floor(rand() * 4)]! : Math.round(base * rand());
      const applied = type === 'percent' ? Math.min(Math.round((base * value) / 100), base) : Math.min(value, base);
      discount = { type, value, appliedAgorot: applied };
    }
    storeSubtotals[slug] = { storeName: 'S', subtotalAgorot: subtotal, shippingAgorot: shipping, ...(discount ? { discount } : {}) };
  }

  const totalAgorot = Object.values(storeSubtotals)
    .reduce((s, st) => s + st.subtotalAgorot + st.shippingAgorot - (st.discount?.appliedAgorot ?? 0), 0);

  // Timestamps clustered on the edges that break calendar code: local midnight, the
  // hour before it, month boundaries, and Israel's DST transitions.
  const EDGE_TIMES = [
    '2026-06-30T21:00:00.000Z', '2026-06-30T22:30:00.000Z', '2026-07-01T00:00:00.000Z',
    '2026-07-15T12:00:00.000Z', '2026-07-31T20:59:59.000Z', '2026-07-31T21:30:00.000Z',
    '2026-10-24T21:30:00.000Z', '2026-10-26T22:30:00.000Z', '2026-02-28T22:00:00.000Z',
  ];
  const createdAt = EDGE_TIMES[Math.floor(rand() * EDGE_TIMES.length)]!;

  return {
    id,
    buyerName: 'B', buyerEmail: 'b@x.test', buyerPhone: '0500000000',
    buyerAddress: { city: 'C', street: 'S' },
    items,
    storeSubtotals,
    shippingAgorot: shippingTotal,
    totalAgorot,
    paymentStatus: PAYMENT[Math.floor(rand() * PAYMENT.length)]!,
    shippingStatus: SHIPPING[Math.floor(rand() * SHIPPING.length)]!,
    createdAt,
    updatedAt: createdAt,
  } as Order;
}

function makeBatch(seed: number, size: number): Order[] {
  const rand = rng(seed);
  return Array.from({ length: size }, (_, i) => makeFuzzOrder(`fz-${seed}-${i}`, rand));
}

// 12 seeds × 25 orders × 3 stores is a few hundred distinct orders per property —
// enough to cover the generator's space several times over. The cap is wall-clock:
// buildPerformanceSummary reads the page-view JSON on every call, so the count is
// tuned to keep the suite fast rather than because more seeds stop finding things.
// Raise it when hunting a specific failure.
const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 7);
const FROM = '2026-06-01';
const TO = '2026-11-30';

// Well past what these need, so a slower machine doesn't turn a green suite red.
describe('reporting survives arbitrary orders', { timeout: 120_000 }, () => {
  it('the bars always add up to the headline, for every seed', () => {
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      for (const slug of STORES) {
        for (const granularity of ['day', 'month'] as const) {
          const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, granularity);
          expect((s.points.reduce((a, p) => a + p.revenueAgorot, 0)), `seed ${seed} / ${slug} / ${granularity}`)
            .toBe(s.totalRevenueAgorot);
          expect(s.points.reduce((a, p) => a + p.orders, 0), `seed ${seed} / ${slug} / ${granularity} orders`)
            .toBe(s.totalOrders);
        }
      }
    }
  });

  it('day and month granularity always agree on the total', () => {
    // Different bucket sizes over the same window must never disagree — a mismatch
    // means one is losing an order at a boundary.
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      for (const slug of STORES) {
        const byDay = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, 'day');
        const byMonth = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, 'month');
        expect(byMonth.totalRevenueAgorot, `seed ${seed} / ${slug}`).toBe(byDay.totalRevenueAgorot);
        expect(byMonth.totalOrders, `seed ${seed} / ${slug} orders`).toBe(byDay.totalOrders);
      }
    }
  });

  it('no report ever counts an unpaid or cancelled order', () => {
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      const live = orders.filter(countsAsRevenue);
      for (const slug of STORES) {
        expect(buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, 'day').totalRevenueAgorot, `seed ${seed} / ${slug}`)
          .toBe(buildPerformanceSummary(live, EMPTY_VIEW_STATS, slug, FROM, TO, 'day').totalRevenueAgorot);
      }
      expect(getOrderTotals(orders).gmvAgorot, `seed ${seed} overview`)
        .toBe(getOrderTotals(live).gmvAgorot);
    }
  });

  it('commission and net profit always partition revenue exactly', () => {
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      for (const rate of [0, 10, 10.25, 12, 100]) {
        const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, STORES[0]!, FROM, TO, 'day', rate);
        expect((s.platformCommissionAgorot + s.netProfitAgorot), `seed ${seed} at ${rate}%`).toBe(s.totalRevenueAgorot);
        expect(s.platformCommissionAgorot, `seed ${seed} commission at ${rate}% within bounds`).toBeLessThanOrEqual(s.totalRevenueAgorot);
        expect(s.platformCommissionAgorot).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the platform total always equals the sum of the seller tabs', () => {
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      const perf = buildPlatformPerformance(buildPlatformSales(orders, STORES, FROM, TO, 'day'), STORES.map((slug) => ({ id: slug, slug, name: slug })), NO_VIEWS, FROM, TO, 'day');
      const sellerSum = STORES.reduce(
        (a, slug) => a + buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, 'day').totalRevenueAgorot, 0,
      );
      expect(perf.summary.totalRevenueAgorot, `seed ${seed}`).toBe(sellerSum);
      expect((perf.stores.reduce((a, r) => a + r.revenueAgorot, 0)), `seed ${seed} rows`).toBe(perf.summary.totalRevenueAgorot);
    }
  });

  it('the admin GMV always equals the sum of the per-store rows', () => {
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      const rowSum = ([...getStoreRevenueMap(orders, MONTH).values()].reduce((a, r) => a + r.totalRevenueAgorot, 0));
      expect(getOrderTotals(orders).gmvAgorot, `seed ${seed}`).toBe(rowSum);
    }
  });

  it('reconciliation finds nothing to report on well-formed orders', () => {
    // The fuzzer builds orders the way checkout does, so a discrepancy here is a bug
    // in the reconciler or in the reporting — not in the data.
    for (const seed of SEEDS) {
      const report = reconcileOrders(makeBatch(seed, 25), STORES);
      expect(report.discrepancies.map((d) => `${d.check}: ${d.subject ?? ''} (${d.driftAgorot})`), `seed ${seed}`).toEqual([]);
    }
  });

  it('reconciliation DOES catch a corrupted order', () => {
    // A reconciler that never fires is indistinguishable from one that is broken.
    // This proves the checks above are actually load-bearing.
    const orders = makeBatch(1, 5);
    const victim = orders[0]!;
    victim.totalAgorot = (victim.totalAgorot + 13.5);
    const report = reconcileOrders(orders, STORES);
    expect(report.clean).toBe(false);
    expect(report.discrepancies.some((d) => d.check === 'סכום ההזמנה מול מרכיביו')).toBe(true);
  });

  it('never produces NaN, Infinity, or a negative total', () => {
    // The failure mode that reaches the screen as "₪NaN" or a blank card.
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      for (const slug of STORES) {
        const s = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, pickGranularity(FROM, TO), 12);
        const numbers: Array<[number, string]> = [
          [s.totalRevenueAgorot, 'totalRevenueAgorot'], [s.avgOrderValueAgorot, 'avgOrderValueAgorot'],
          [s.conversionRate, 'conversionRate'], [s.platformCommissionAgorot, 'commission'],
          [s.netProfitAgorot, 'netProfitAgorot'],
          ...s.points.map((p): [number, string] => [p.revenueAgorot, `point ${p.key}`]),
          ...s.topProducts.map((p): [number, string] => [p.revenueAgorot, `product ${p.productId}`]),
        ];
        for (const [n, name] of numbers) {
          expect(Number.isFinite(n), `seed ${seed} / ${slug} / ${name} is finite`).toBe(true);
          expect(n, `seed ${seed} / ${slug} / ${name} is not negative`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('a product drill-down never exceeds its store total', () => {
    // A per-product figure larger than the store's whole revenue is impossible, and
    // it is exactly what a double-count in the item loop would produce.
    for (const seed of SEEDS) {
      const orders = makeBatch(seed, 25);
      for (const slug of STORES) {
        const store = buildPerformanceSummary(orders, EMPTY_VIEW_STATS, slug, FROM, TO, 'day', 0, 0);
        const grossTotal = (store.topProducts.reduce((a, p) => a + p.revenueAgorot, 0));
        for (const tp of store.topProducts) {
          const p = buildProductPerformance(orders, EMPTY_PRODUCT_VIEW_STATS, slug, tp.productId, FROM, TO, 'day');
          expect(p.totalRevenueAgorot, `seed ${seed} / ${slug} / ${tp.productId}`).toBeLessThanOrEqual(grossTotal);
          expect((p.points.reduce((a, x) => a + x.revenueAgorot, 0)), `seed ${seed} / ${slug} / ${tp.productId} bars`)
            .toBe(p.totalRevenueAgorot);
        }
      }
    }
  });

  it('an order is counted in the range that contains its business day, and no other', () => {
    // Walks each order's own day rather than trusting a fixed window — catches an
    // off-by-one at any boundary the generator happens to land on, including DST.
    for (const seed of SEEDS.slice(0, 10)) {
      for (const o of makeBatch(seed, 25)) {
        if (!countsAsRevenue(o)) continue;
        const day = businessDayISO(new Date(o.createdAt));
        for (const slug of Object.keys(o.storeSubtotals)) {
          const onItsDay = buildPerformanceSummary([o], EMPTY_VIEW_STATS, slug, day, day, 'day');
          expect(onItsDay.totalOrders, `seed ${seed} / ${o.id} on ${day}`).toBe(1);
          expect((onItsDay.totalRevenueAgorot)).toBe((orderNetTotal(o) - Object.entries(o.storeSubtotals)
            .filter(([s]) => s !== slug)
            .reduce((a, [s]) => a + (o.storeSubtotals[s]!.subtotalAgorot - (o.storeSubtotals[s]!.discount?.appliedAgorot ?? 0)), 0)));
        }
      }
    }
  });
});
