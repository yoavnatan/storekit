/**
 * The buyer funnel against a real Postgres — the third of the six daily buckets to move
 * (DB_MIGRATION_PLAN.md §5, §8), and the one with no reader in common with the page-view pair.
 *
 * **Previous coverage: none of the three functions that touch storage.** The nine tests that
 * existed all built an `AnalyticsData` object by hand, and `checkout.test.ts` mocked the module
 * outright — measured before the move by stubbing `getAnalyticsOverview` to an empty funnel,
 * `getLifetimeEventSessions` to 0 and `recordAnalyticsEvent` to a no-op: 1706 of 1707 tests still
 * passed. So the behaviour pinned here is everything a green suite used to allow.
 *
 * Two traps drive most of it. A funnel stage is `COUNT(DISTINCT visitor_id)` over the RANGE and is
 * not the sum of its days — a session that comes back tomorrow is one session. And a single call
 * may name the same product twice (a checkout with two variants of one product), which Postgres
 * refuses to let `ON CONFLICT DO UPDATE` touch twice in one command.
 *
 * Isolation: reads seed their own far-future days by SQL, so they never see another test's rows;
 * writes go to today's business day and are asserted through the ids they used.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { businessDayISO } from '../src/lib/business-day.js';
import {
  buildFunnel,
  getAnalyticsOverview,
  getEventTotals,
  getLifetimeEventSessions,
  getTopAbandonedProducts,
  getTopProductsByEvent,
  recordAnalyticsEvent,
  type AnalyticsEvent,
} from '../src/lib/analytics.js';

const today = businessDayISO(new Date());

/** A fresh id per call, so two tests writing the same event on the same day never collide. */
const vid = (): string => `vis-${crypto.randomBytes(6).toString('hex')}`;
const pid = (): string => crypto.randomUUID();

interface SeedBucket { count: number; visitors?: string[]; products?: Record<string, number> }

/** Write one day's bucket straight to the tables — the shape the reader has to make sense of. */
async function seedDay(day: string, event: AnalyticsEvent, bucket: SeedBucket): Promise<void> {
  await query(
    `INSERT INTO analytics_daily (day, event, count) VALUES ($1::date, $2, $3)
     ON CONFLICT (day, event) DO UPDATE SET count = EXCLUDED.count`,
    [day, event, bucket.count],
  );
  for (const v of bucket.visitors ?? []) {
    await query(
      `INSERT INTO analytics_visitors (day, event, visitor_id) VALUES ($1::date, $2, $3)
       ON CONFLICT DO NOTHING`,
      [day, event, v],
    );
  }
  for (const [productId, n] of Object.entries(bucket.products ?? {})) {
    await query(
      `INSERT INTO analytics_products (day, event, product_id, count) VALUES ($1::date, $2, $3, $4)
       ON CONFLICT (day, event, product_id) DO UPDATE SET count = EXCLUDED.count`,
      [day, event, productId, n],
    );
  }
}

async function productTally(day: string, event: AnalyticsEvent, productId: string): Promise<number> {
  const { rows } = await query<{ count: number | string }>(
    `SELECT count FROM analytics_products WHERE day = $1::date AND event = $2 AND product_id = $3`,
    [day, event, productId],
  );
  return Number(rows[0]?.count ?? 0);
}

describe('recordAnalyticsEvent', () => {
  it('bumps volume, files the session once, and tallies the product', async () => {
    const session = vid();
    const productId = pid();
    await recordAnalyticsEvent('view_item', { vid: session, productIds: [productId] });
    await recordAnalyticsEvent('view_item', { vid: session, productIds: [productId] });

    const { rows: sessions } = await query<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM analytics_visitors WHERE day = $1::date AND event = 'view_item' AND visitor_id = $2`,
      [today, session],
    );
    // Two fires, one session row: a stage counts people, not clicks.
    expect(Number(sessions[0]!.n)).toBe(1);
    expect(await productTally(today, 'view_item', productId)).toBe(2);
  });

  it('adds two when ONE call names the same product twice', async () => {
    // A checkout with two lines of the same product in different variants sends the id twice.
    // Postgres rejects an ON CONFLICT DO UPDATE that would touch the same row twice in one
    // command, so the tally is grouped before it is inserted — and the call must still resolve.
    const productId = pid();
    await expect(recordAnalyticsEvent('purchase', { vid: vid(), productIds: [productId, productId] }))
      .resolves.toBeUndefined();
    expect(await productTally(today, 'purchase', productId)).toBe(2);
  });

  it('records volume even when no session id is known', async () => {
    // The quick-view API can fire before the visitor cookie exists. That view still happened.
    const before = (await getEventTotals(today, today)).view_item?.count ?? 0;
    await recordAnalyticsEvent('view_item', {});
    expect((await getEventTotals(today, today)).view_item!.count).toBe(before + 1);
  });

  it('files the event on the business day the application decided (§7.8)', async () => {
    const session = vid();
    await recordAnalyticsEvent('begin_checkout', { vid: session });
    const { rows } = await query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM analytics_visitors WHERE visitor_id = $1`,
      [session],
    );
    expect(rows[0]!.day).toBe(businessDayISO(new Date()));
  });

  it('never throws, whatever it is handed', async () => {
    // It runs on every page load and at the end of checkout; a rejection here would be a 500 on a
    // request that had already succeeded.
    await expect(recordAnalyticsEvent('page_view', { vid: '' })).resolves.toBeUndefined();
    await expect(recordAnalyticsEvent('page_view', { productIds: [] })).resolves.toBeUndefined();
    await expect(recordAnalyticsEvent('page_view', { productIds: ['', 'x'.repeat(500)] }))
      .resolves.toBeUndefined();
  });
});

describe('getEventTotals', () => {
  it('counts a session ONCE across the range, and sums the volume', async () => {
    // The trap the whole module is shaped around: a returning session is one session. Summing the
    // two days would say 3 — and that number would flow into every rate on the panel.
    const [a, b, c] = [vid(), vid(), vid()];
    await seedDay('2031-03-01', 'page_view', { count: 10, visitors: [a, b] });
    await seedDay('2031-03-02', 'page_view', { count: 4, visitors: [a, c] });

    const totals = await getEventTotals('2031-03-01', '2031-03-02');
    expect(totals.page_view).toEqual({ sessions: 3, count: 14 });
  });

  it('narrows when the range excludes a day', async () => {
    const [a, b, c] = [vid(), vid(), vid()];
    await seedDay('2031-04-01', 'add_to_cart', { count: 3, visitors: [a, b] });
    await seedDay('2031-04-02', 'add_to_cart', { count: 5, visitors: [c] });
    const totals = await getEventTotals('2031-04-01', '2031-04-01');
    expect(totals.add_to_cart).toEqual({ sessions: 2, count: 3 });
  });

  it('reports a day that holds volume but no session ids at all', async () => {
    // Rows imported from before the visitor cookie existed carry a bare count. An inner join would
    // drop them and under-report the funnel's top for every historical window.
    await seedDay('2031-05-01', 'page_view', { count: 7 });
    expect((await getEventTotals('2031-05-01', '2031-05-01')).page_view).toEqual({ sessions: 0, count: 7 });
  });

  it('leaves an event nobody fired out of the result', async () => {
    await seedDay('2031-06-01', 'page_view', { count: 1, visitors: [vid()] });
    const totals = await getEventTotals('2031-06-01', '2031-06-01');
    expect(totals.purchase).toBeUndefined();
    // …and the funnel still lays out five stages over it.
    expect(buildFunnel(totals).find((s) => s.event === 'purchase')!.sessions).toBe(0);
  });

  it('answers a date-shaped non-date with no data instead of a 500', async () => {
    // `2026-02-30` has the shape and no meaning. Postgres RAISES on the cast rather than matching
    // nothing, so an old bookmark would take the admin page down (business-day.ts#isDayISO).
    await expect(getEventTotals('2026-02-30', '2026-03-01')).resolves.toEqual({});
    await expect(getEventTotals('2031-03-01', '9999-99-99')).resolves.toEqual({});
  });
});

describe('getTopProductsByEvent', () => {
  it('ranks by tally, scoped to the event, and honours the limit', async () => {
    const [p1, p2, p3] = [pid(), pid(), pid()];
    await seedDay('2031-07-01', 'add_to_cart', { count: 9, products: { [p1]: 2, [p2]: 5, [p3]: 1 } });
    await seedDay('2031-07-02', 'add_to_cart', { count: 4, products: { [p1]: 4 } });
    await seedDay('2031-07-01', 'purchase', { count: 6, products: { [p3]: 6 } });

    const top = await getTopProductsByEvent('add_to_cart', '2031-07-01', '2031-07-02');
    expect(top).toEqual([
      { productId: p1, count: 6 },   // 2 + 4 across both days
      { productId: p2, count: 5 },
      { productId: p3, count: 1 },   // its six PURCHASES belong to another event
    ]);
    expect(await getTopProductsByEvent('add_to_cart', '2031-07-01', '2031-07-02', 1))
      .toEqual([{ productId: p1, count: 6 }]);
  });

  it('keeps a product whose id predates uuids', async () => {
    // `analytics_products.product_id` is text with no foreign key on purpose: a tally of a deleted
    // (or pre-uuid) product is still history, and dropping it would understate a past month.
    await seedDay('2031-07-05', 'view_item', { count: 3, products: { 'legacy-product-id': 3 } });
    expect(await getTopProductsByEvent('view_item', '2031-07-05', '2031-07-05'))
      .toEqual([{ productId: 'legacy-product-id', count: 3 }]);
  });
});

describe('getTopAbandonedProducts', () => {
  it('reports added-minus-purchased, drops what fully converted, sorts by the gap', async () => {
    const [gap3, gap1, converted] = [pid(), pid(), pid()];
    await seedDay('2031-08-01', 'add_to_cart', { count: 9, products: { [gap3]: 4, [gap1]: 1, [converted]: 5 } });
    await seedDay('2031-08-01', 'purchase', { count: 6, products: { [gap3]: 1, [converted]: 5 } });

    const ab = await getTopAbandonedProducts('2031-08-01', '2031-08-01');
    expect(ab).toEqual([
      { productId: gap3, added: 4, purchased: 1, abandoned: 3 },
      { productId: gap1, added: 1, purchased: 0, abandoned: 1 },
    ]);
  });

  it('ranks by the GAP, not by adds, so the limit keeps the right rows', async () => {
    // `busy` is added ten times as often and nearly always sells; `leaky` is quieter and never
    // converts. Ordering by adds and trimming afterwards would spend the single slot on the
    // product with almost nothing to report — the report exists to surface `leaky`.
    const [busy, leaky] = [pid(), pid()];
    await seedDay('2031-09-01', 'add_to_cart', { count: 110, products: { [busy]: 100, [leaky]: 10 } });
    await seedDay('2031-09-01', 'purchase', { count: 99, products: { [busy]: 99 } });

    expect(await getTopAbandonedProducts('2031-09-01', '2031-09-01', 1))
      .toEqual([{ productId: leaky, added: 10, purchased: 0, abandoned: 10 }]);
    // Both are real gaps — the ranking is what the limit acts on, not a filter that hid one.
    expect((await getTopAbandonedProducts('2031-09-01', '2031-09-01')).map((p) => p.productId))
      .toEqual([leaky, busy]);
  });

  it('answers a date-shaped non-date with no rows instead of a 500', async () => {
    await expect(getTopAbandonedProducts('2026-02-30', '2026-03-01')).resolves.toEqual([]);
    await expect(getTopProductsByEvent('add_to_cart', '2026-02-30', '2026-03-01')).resolves.toEqual([]);
  });
});

describe('getLifetimeEventSessions', () => {
  it('counts a session once across ALL days, ignoring any range', async () => {
    // The seller-onboarding funnel's top is cumulative by design: someone who visited the register
    // page in March and again in July is one would-be seller.
    const before = await getLifetimeEventSessions('seller_register_view');
    const returning = vid();
    await seedDay('2031-10-01', 'seller_register_view', { count: 1, visitors: [returning] });
    await seedDay('2031-11-01', 'seller_register_view', { count: 1, visitors: [returning, vid()] });
    expect(await getLifetimeEventSessions('seller_register_view')).toBe(before + 2);
  });

  it('returns a NUMBER zero for an event nobody ever fired', async () => {
    // `COUNT` is a bigint: a string from `pg`, a number from PGlite (§8). `toBe(0)` fails on '0',
    // which is the assertion — the value lands in arithmetic on the seller funnel.
    expect(await getLifetimeEventSessions('never_fired' as AnalyticsEvent)).toBe(0);
  });
});

describe('getAnalyticsOverview', () => {
  it('assembles funnel, rates and both product rankings for one window', async () => {
    const [a, b, c, d] = [vid(), vid(), vid(), vid()];
    const [p1, p2] = [pid(), pid()];
    await seedDay('2031-12-01', 'page_view', { count: 10, visitors: [a, b, c] });
    await seedDay('2031-12-02', 'page_view', { count: 4, visitors: [a, d] });
    await seedDay('2031-12-01', 'view_item', { count: 5, visitors: [a, b], products: { [p1]: 3, [p2]: 2 } });
    await seedDay('2031-12-01', 'add_to_cart', { count: 4, visitors: [a], products: { [p1]: 3, [p2]: 1 } });
    await seedDay('2031-12-01', 'begin_checkout', { count: 1, visitors: [a] });
    await seedDay('2031-12-01', 'purchase', { count: 1, visitors: [a], products: { [p1]: 1 } });

    const o = await getAnalyticsOverview('2031-12-01', '2031-12-02');
    expect(o.funnel.map((s) => s.sessions)).toEqual([4, 2, 1, 1, 1]);
    expect(o.funnel.map((s) => s.count)).toEqual([14, 5, 4, 1, 1]);
    expect(o.rates.bounceRate).toBeCloseTo(50);        // (4 sessions - 2 viewed) / 4
    expect(o.rates.conversionRate).toBeCloseTo(25);    // 1 purchase / 4 sessions
    expect(o.topAdded).toEqual([{ productId: p1, count: 3 }, { productId: p2, count: 1 }]);
    expect(o.topAbandoned).toEqual([
      { productId: p1, added: 3, purchased: 1, abandoned: 2 },
      { productId: p2, added: 1, purchased: 0, abandoned: 1 },
    ]);
  });
});
