/**
 * The PURE half of the funnel — everything that is arithmetic rather than a query.
 *
 * These used to take the whole `analytics-events.json` shape and a date range, and do the
 * aggregation themselves. They now take `EventTotals`, which the database has already reduced to
 * one row per event (DB_MIGRATION_PLAN.md §5): a funnel stage is a distinct session count over the
 * range, and no arrangement of per-day numbers can produce it. What survived the move is the part
 * worth keeping out of a database — the stage list, and the four rates derived from it, including
 * the clamps that stop a report from claiming a negative or >100% figure.
 *
 * The I/O half lives in `analytics-db.test.ts`, against a real Postgres.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFunnel,
  buildAnalyticsRates,
  type EventTotals,
} from '../src/lib/analytics.js';

// One window's totals, as `getEventTotals` returns them. `sessions` ≠ `count` throughout: four
// sessions produced fourteen page loads, and the rates must read the former.
const totals: EventTotals = {
  page_view: { sessions: 4, count: 14 },
  view_item: { sessions: 3, count: 7 },
  add_to_cart: { sessions: 2, count: 4 },
  begin_checkout: { sessions: 1, count: 1 },
  purchase: { sessions: 1, count: 1 },
};

describe('buildFunnel', () => {
  it('reports each stage in sessions, keeping raw volume alongside it', () => {
    const by = Object.fromEntries(buildFunnel(totals).map((s) => [s.event, s]));
    expect(by.page_view).toEqual({ event: 'page_view', sessions: 4, count: 14 });
    expect(by.add_to_cart).toEqual({ event: 'add_to_cart', sessions: 2, count: 4 });
  });

  it('returns all five stages in funnel order', () => {
    expect(buildFunnel(totals).map((s) => s.event))
      .toEqual(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase']);
  });

  it('renders a stage with no traffic as a zero, not a hole', () => {
    // An absent key is what the query returns for an event nobody fired in the window; the panel
    // lays out five bars either way and must not be handed `undefined`.
    const stages = buildFunnel({ page_view: { sessions: 2, count: 9 } });
    expect(stages).toHaveLength(5);
    expect(stages.find((s) => s.event === 'purchase')).toEqual({ event: 'purchase', sessions: 0, count: 0 });
  });

  it('ignores events outside the buyer funnel', () => {
    // seller_register_view shares the tables (it is the seller funnel's top) and must never
    // appear as a buyer stage.
    const stages = buildFunnel({ ...totals, seller_register_view: { sessions: 99, count: 99 } });
    expect(stages).toHaveLength(5);
    expect(stages.some((s) => (s.event as string) === 'seller_register_view')).toBe(false);
  });
});

describe('buildAnalyticsRates', () => {
  it('computes bounce / cart-abandonment / checkout-abandonment / conversion from sessions', () => {
    const r = buildAnalyticsRates(totals);
    expect(r.bounceRate).toBeCloseTo(25);              // (4 sessions - 3 viewed) / 4
    expect(r.cartAbandonmentRate).toBeCloseTo(50);     // (2 added - 1 bought) / 2
    expect(r.checkoutAbandonmentRate).toBeCloseTo(0);  // 1 reached checkout, 1 bought
    expect(r.conversionRate).toBeCloseTo(25);          // 1 purchase / 4 sessions
  });

  it('derives every rate from sessions, never from raw volume', () => {
    // Same sessions, ten times the page loads: the rates must not move. Volume and reach are
    // different questions, and reading the wrong one inflates conversion silently.
    const loud: EventTotals = Object.fromEntries(
      Object.entries(totals).map(([e, t]) => [e, { sessions: t.sessions, count: t.count * 10 }]),
    );
    expect(buildAnalyticsRates(loud)).toEqual(buildAnalyticsRates(totals));
  });

  it('zero-guards an empty range instead of dividing by zero', () => {
    expect(buildAnalyticsRates({})).toMatchObject({
      sessions: 0, bounceRate: 0, cartAbandonmentRate: 0, checkoutAbandonmentRate: 0, conversionRate: 0,
    });
  });

  it('never reports a negative rate when a stage exceeds its predecessor', () => {
    // A purchase with no tracked add (e.g. the add fired before the cookie existed):
    // cart abandonment must clamp to 0, not go negative.
    const odd: EventTotals = { add_to_cart: { sessions: 1, count: 1 }, purchase: { sessions: 2, count: 2 } };
    expect(buildAnalyticsRates(odd).cartAbandonmentRate).toBe(0);
  });
});
