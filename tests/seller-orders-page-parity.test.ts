/**
 * The seller Orders tab's page, against a real Postgres — and against the JS it replaced.
 *
 * Same move the admin tab made in DB_MIGRATION_PLAN §3, and the same reason a parity test rather
 * than a rewrite: the tab was already paginated, but the READ behind it was the store's entire
 * order history, filtered and sorted in JavaScript so fifteen rows could survive (owner,
 * 2026-08-11). What must not have moved is the meaning — what the search box matches, which sort
 * exists, how a tie breaks — because a seller who searches for an order and is told it does not
 * exist cannot tell a filter bug from a missing order.
 *
 * So `filterAndSortSellerOrders` stays as the definition and every case below runs both routes over
 * the SAME rows. The urgency sort is the one worth the most attention: it is the only ordering on
 * this screen with a rule inside a rule (owed-action group first, and OLDEST first inside it), and
 * it is now written twice — once in JS and once as an `ORDER BY`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getSellerOrdersPage, getSellerOrderStatusCounts, getSellerOrdersSince, type Order } from '../src/lib/orders.js';
import {
  filterAndSortSellerOrders, URGENCY_GROUPS, URGENCY_STATUSES, URGENCY_RANKS,
  type SellerOrderQuery,
} from '../src/lib/seller-orders-query.js';
import { SHIPPING_STATUS_RULES } from '../src/lib/order-status-rules.js';

const SLUG = 'keramika';
const OTHER = 'tachshitim';

interface Seed {
  ref: string;
  buyer: string;
  email: string;
  phone: string;
  /** This store's slice: subtotal, shipping, discount — the "sort by amount" key. */
  subtotal: number;
  shipping: number;
  discount: number;
  status: Order['shippingStatus'];
  at: string;
  /** A second store on the same checkout — its slice must never move this seller's sort. */
  alsoOther?: number;
  /** Owned through its items only: no `order_stores` row for this store. */
  sliceless?: boolean;
}

const SEEDS: Seed[] = [
  { ref: 'SO-1', buyer: 'דנה כהן',  email: 'dana@example.com',  phone: '0501111111', subtotal: 12000, shipping: 3000, discount: 0,    status: 'delivered',  at: '2026-07-01T09:00:00.000Z' },
  { ref: 'SO-2', buyer: 'יוסי לוי', email: 'yossi@example.com', phone: '0502222222', subtotal: 5500,  shipping: 0,    discount: 500,  status: 'pending',    at: '2026-07-02T09:00:00.000Z' },
  { ref: 'SO-3', buyer: 'דנה לוי',  email: 'dana2@example.com', phone: '0503333333', subtotal: 99000, shipping: 3000, discount: 0,    status: 'processing', at: '2026-07-03T09:00:00.000Z', alsoOther: 400000 },
  { ref: 'SO-4', buyer: 'רון גל',   email: 'ron@example.com',   phone: '0504444444', subtotal: 700,   shipping: 0,    discount: 0,    status: 'cancelled',  at: '2026-07-04T09:00:00.000Z' },
  { ref: 'SO-5', buyer: 'שרה מור',  email: 'sara@example.com',  phone: '0505555555', subtotal: 3300,  shipping: 2000, discount: 1000, status: 'shipped',    at: '2026-07-05T09:00:00.000Z' },
  // Same instant as SO-5, and in the owed-action group — both tie-breaks in one row.
  { ref: 'SO-6', buyer: 'שרה מור',  email: 'sara@example.com',  phone: '0505555555', subtotal: 3300,  shipping: 0,    discount: 0,    status: 'ready',      at: '2026-07-05T09:00:00.000Z' },
  { ref: 'SO-7', buyer: 'אבי נחום', email: 'avi@example.com',   phone: '0506666666', subtotal: 8000,  shipping: 0,    discount: 0,    status: 'pending',    at: '2026-06-01T09:00:00.000Z' },
  // No `order_stores` row at all — the store owns this order through its ITEMS alone, which
  // `BELONGS_TO_SLUGS` allows on purpose (both legs exist because two statements write them). Its
  // slice total is therefore absent on one side and 0 on the other, and "sort by amount" is where
  // that difference shows: Postgres sorts NULLs FIRST in DESC, so without a COALESCE this row would
  // head the list while the JS puts it last.
  { ref: 'SO-8', buyer: 'נועה שחר', email: 'noa@example.com',   phone: '0507777777', subtotal: 4400,  shipping: 0,    discount: 0,    status: 'pending',    at: '2026-06-15T09:00:00.000Z', sliceless: true },
];

/** Everything the store has, unfiltered — the array the JS reference used to be handed. */
const ALL = async (): Promise<Order[]> =>
  (await getSellerOrdersPage(SLUG, { q: '', sortCol: 'date', sortDir: 'desc', shippingStatus: [] }, 1, 10_000)).orders;

beforeAll(async () => {
  // A clean table for this file: the fixture's own orders would make "the two agree" true while
  // saying nothing about the cases below.
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM money_events');
  await query('DELETE FROM orders');
  for (const s of SEEDS) {
    const id = crypto.randomUUID();
    const total = s.subtotal + s.shipping - s.discount + (s.alsoOther ?? 0);
    await query(
      `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone, total_agorot,
                           payment_status, shipping_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7, $8::timestamptz)`,
      [id, s.ref, s.buyer, s.email, s.phone, total, s.status, s.at],
    );
    await query(
      `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
       VALUES ($1, $2, 'פריט', $3, 'קרמיקה', $4, 1, 0)`,
      [crypto.randomUUID(), id, SLUG, s.subtotal],
    );
    if (!s.sliceless) {
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot, discount_applied_agorot)
         VALUES ($1, $2, 'קרמיקה', $3, $4, $5)`,
        [id, SLUG, s.subtotal, s.shipping, s.discount],
      );
    }
    if (s.alsoOther) {
      await query(
        `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
         VALUES ($1, $2, 'פריט אחר', $3, 'תכשיטים', $4, 1, 1)`,
        [crypto.randomUUID(), id, OTHER, s.alsoOther],
      );
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot)
         VALUES ($1, $2, 'תכשיטים', $3)`,
        [id, OTHER, s.alsoOther],
      );
    }
  }
});

const q = (over: Partial<SellerOrderQuery> = {}): SellerOrderQuery =>
  ({ q: '', sortCol: 'date', sortDir: 'desc', shippingStatus: [], ...over });

/** Run both routes over the same rows and require the same list of order ids, in order. */
async function bothAgree(query: SellerOrderQuery, label: string): Promise<Order[]> {
  const page = await getSellerOrdersPage(SLUG, query, 1, 10_000);
  const pure = filterAndSortSellerOrders(await ALL(), SLUG, query);
  expect(page.orders.map((o) => o.checkoutRef), `${label}: query vs filterAndSortSellerOrders`)
    .toEqual(pure.map((o) => o.checkoutRef));
  expect(page.total, `${label}: total`).toBe(pure.length);
  return page.orders;
}

describe('getSellerOrdersPage agrees with filterAndSortSellerOrders', () => {
  it('with nothing narrowing it', async () => {
    const rows = await bothAgree(q(), 'unfiltered');
    expect(rows).toHaveLength(SEEDS.length);
  });

  for (const sortCol of ['date', 'amount', 'urgency'] as const) {
    for (const sortDir of ['asc', 'desc'] as const) {
      it(`sorting by ${sortCol}:${sortDir}`, async () => {
        await bothAgree(q({ sortCol, sortDir }), `${sortCol}:${sortDir}`);
      });
    }
  }

  it('sorts by amount on THIS store\'s slice, not the order total', async () => {
    // SO-3 carries a 4,000₪ slice for another store on the same checkout. Sorted by amount
    // descending it must still sit where its own 1,020₪ slice puts it — below SO-1's 1,500₪.
    const rows = await bothAgree(q({ sortCol: 'amount', sortDir: 'desc' }), 'amount by slice');
    expect(rows[0]!.checkoutRef).toBe('SO-3');
    expect(rows.map((o) => o.checkoutRef).indexOf('SO-1')).toBe(1);
  });

  // ASC, because that is the only direction the toolbar ever sends for this sort
  // (`ORDER_SORT_OPTIONS` in scripts/dashboard/orders.ts): the ranks count UP from "you owe an
  // action", so ascending IS most-urgent-first. Descending is still defined — the whole comparison
  // flips, cancelled to the top — and the parity cases above cover it; it is simply not a thing the
  // screen offers.
  it('puts the owed-action group first and its OLDEST order on top', async () => {
    const rows = await bothAgree(q({ sortCol: 'urgency', sortDir: 'asc' }), 'urgency');
    const owed = URGENCY_GROUPS[0]!;
    const firstFour = rows.slice(0, 4);
    expect(firstFour.every((o) => owed.includes(o.shippingStatus))).toBe(true);
    // SO-7 is June; every other owed-action row is July.
    expect(rows[0]!.checkoutRef).toBe('SO-7');
    // …and the terminal one is last.
    expect(rows[rows.length - 1]!.checkoutRef).toBe('SO-4');
  });

  it('filtering by shipping status', async () => {
    const rows = await bothAgree(q({ shippingStatus: ['pending', 'shipped'] }), 'status filter');
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['SO-2', 'SO-5', 'SO-7', 'SO-8']);
  });

  it('an EMPTY status list means every status, not none', async () => {
    const rows = await bothAgree(q({ shippingStatus: [] }), 'cleared filter');
    expect(rows).toHaveLength(SEEDS.length);
  });

  for (const term of ['דנה', 'dana@example.com', '0503333333', 'SO-4', 'לא קיים']) {
    it(`free-text search for "${term}"`, async () => {
      await bothAgree(q({ q: term }), `search ${term}`);
    });
  }

  it('matches case-insensitively, as the JS lowercases both sides', async () => {
    const rows = await bothAgree(q({ q: 'DANA@EXAMPLE.COM' }), 'uppercase search');
    expect(rows.map((o) => o.checkoutRef)).toEqual(['SO-1']);
  });

  it('combines a search with a status filter instead of replacing it', async () => {
    const rows = await bothAgree(q({ q: 'דנה', shippingStatus: ['processing'] }), 'search + filter');
    expect(rows.map((o) => o.checkoutRef)).toEqual(['SO-3']);
  });
});

describe('paging', () => {
  it('slices the same order the whole list is in, and reports the real total', async () => {
    const all = await bothAgree(q(), 'baseline');
    const p1 = await getSellerOrdersPage(SLUG, q(), 1, 3);
    const p2 = await getSellerOrdersPage(SLUG, q(), 2, 3);
    expect(p1.orders.map((o) => o.checkoutRef)).toEqual(all.slice(0, 3).map((o) => o.checkoutRef));
    expect(p2.orders.map((o) => o.checkoutRef)).toEqual(all.slice(3, 6).map((o) => o.checkoutRef));
    expect(p1.total).toBe(SEEDS.length);
    expect(p1.totalPages).toBe(Math.ceil(SEEDS.length / 3));
  });

  it('a page past the end clamps instead of reporting an empty store', async () => {
    const page = await getSellerOrdersPage(SLUG, q(), 999, 3);
    expect(page.total).toBe(SEEDS.length);
    expect(page.page).toBe(page.totalPages);
    expect(page.orders.length).toBeGreaterThan(0);
  });

  it('another seller\'s store sees none of these', async () => {
    const page = await getSellerOrdersPage('no-such-store', q(), 1, 15);
    expect(page.orders).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('the counts beside the list', () => {
  it('counts every status, and the sum is the store\'s whole history', async () => {
    const counts = await getSellerOrderStatusCounts(SLUG);
    expect(counts['pending']).toBe(3);
    expect(counts['processing']).toBe(1);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(SEEDS.length);
  });
});

describe('the new-order poll asks for a watermark, not for the history', () => {
  it('seeds with the newest moment and no rows at all', async () => {
    const seed = await getSellerOrdersSince(SLUG, '');
    expect(seed.orders).toEqual([]);
    expect(Date.parse(seed.since)).toBeGreaterThan(0);
  });

  it('returns only what is newer, and hands back a watermark that moves', async () => {
    const from = await getSellerOrdersSince(SLUG, '2026-07-03T00:00:00.000Z');
    expect(from.orders.map((o) => o.checkoutRef).sort()).toEqual(['SO-3', 'SO-4', 'SO-5', 'SO-6']);
    expect(from.since).toBe('2026-07-05T09:00:00.000Z');
    // Asked again with what it was given, the same window is inclusive of its own edge — the two
    // rows written at that instant come back, and the caller de-duplicates by id rather than
    // losing one of them.
    const again = await getSellerOrdersSince(SLUG, from.since);
    expect(again.orders.map((o) => o.checkoutRef).sort()).toEqual(['SO-5', 'SO-6']);
  });

  it('a hand-edited ?since= is dropped, never handed to Postgres as a timestamp', async () => {
    const junk = await getSellerOrdersSince(SLUG, 'not-a-date');
    expect(junk.orders).toEqual([]);
    expect(Date.parse(junk.since)).toBeGreaterThan(0);
  });
});

describe('the urgency grouping stays derived from the status table', () => {
  it('covers every status exactly once', () => {
    expect([...URGENCY_STATUSES].sort()).toEqual(Object.keys(SHIPPING_STATUS_RULES).sort());
    expect(URGENCY_STATUSES).toHaveLength(URGENCY_RANKS.length);
  });

  it('group 0 is exactly the statuses the seller still owes an action on', () => {
    const owed = Object.entries(SHIPPING_STATUS_RULES)
      .filter(([, rule]) => rule.sellerOwesAction).map(([status]) => status);
    expect([...URGENCY_GROUPS[0]!].sort()).toEqual(owed.sort());
  });

  it('puts the terminal statuses last', () => {
    const last = URGENCY_GROUPS[URGENCY_GROUPS.length - 1]!;
    expect(last.every((s) => SHIPPING_STATUS_RULES[s as keyof typeof SHIPPING_STATUS_RULES].terminal)).toBe(true);
  });
});
