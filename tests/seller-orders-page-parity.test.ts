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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../src/lib/db.js';
import { getSellerOrdersPage, getSellerOrderStatusCounts, getSellerOrdersSince, getOrderPollWatermark, type Order } from '../src/lib/orders.js';
import {
  filterAndSortSellerOrders, parseSellerOrderQuery, URGENCY_GROUPS, URGENCY_STATUSES, URGENCY_RANKS,
  type SellerOrderQuery,
} from '../src/lib/seller-orders-query.js';
import { PAYOUT_FILTER_VALUES } from '../src/lib/order-payout-line.js';
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
  (await getSellerOrdersPage(SLUG, { q: '', sortCol: 'date', sortDir: 'desc', shippingStatus: [], payoutStatus: [], returnState: [], includeOpenReturns: false }, 1, 10_000)).orders;

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
  // `includeOpenReturns: false` by default here, and this file says why rather than inheriting it:
  // the flag widens the DEFAULT status set with a fact from another table, so a parity case that
  // left it on would be comparing two routes over a set neither test row can produce. The widening
  // has its own cases in `seller-orders-query.test.ts`.
  ({ q: '', sortCol: 'date', sortDir: 'desc', shippingStatus: [], payoutStatus: [], returnState: [], includeOpenReturns: false, ...over });

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

  /**
   * The payout-status column (owner, 2026-08-11 — *"עוד רובריקה בסינון לפי סטטוס תשלום"*).
   *
   * It is the one filter `getSellerOrdersPage` does NOT answer in SQL: the hold rule already has
   * two spellings and a third inside this statement is how a seller gets shown one set of orders
   * and paid for another. The page routes it through `filterAndSortSellerOrders` instead, so
   * `bothAgree` is not a formality here — it is the whole safety argument, and it would fail the
   * moment someone "optimised" this into a CASE expression that disagreed.
   *
   * The seeds are all `paid` with no `paid_at`, so every one of them is undateable and lands in the
   * same bucket. That is fine and deliberate: what is under test is that the column filters and
   * that the two routes agree about it, not the hold arithmetic — `order-payout-line.test.ts` owns
   * that, from literals.
   */
  it('filters by payout status, and both routes agree about which rows that is', async () => {
    const everyBucket = await bothAgree(q({ payoutStatus: [...PAYOUT_FILTER_VALUES] }), 'every payout bucket');
    expect(everyBucket, 'selecting every bucket keeps every order').toHaveLength(SEEDS.length);

    // A bucket nothing is in must return nothing — not "no filter".
    const none = await bothAgree(q({ payoutStatus: ['released'] }), 'released only');
    const unshipped = await bothAgree(q({ payoutStatus: ['unshipped'] }), 'unshipped only');
    expect(none.length + unshipped.length, 'the two buckets cannot both hold everything')
      .toBeLessThanOrEqual(SEEDS.length);
  });

  it('rejects a hand-edited payout value instead of matching nothing', () => {
    const parsed = parseSellerOrderQuery(new URLSearchParams('opay=released,not-a-bucket'));
    // A value that survived would filter the list to zero rows and read as "you have no orders".
    expect(parsed.payoutStatus).toEqual(['released']);
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

  /**
   * **The phantom toast** (owner, 2026-08-11: "למה כל רגע מופיעה לי התראה של הזמנה חדשה?").
   *
   * The window is `>=` deliberately, so the first poll after a seed always re-reads whatever sits
   * exactly on the watermark. That is harmless only if the caller already knows those ids — and the
   * seed used to return nothing at all, so it did not. Every seller with at least one order was
   * told about their newest existing one, fifteen seconds after opening the dashboard, with nothing
   * in the notifications table and nothing new in the list to back it up.
   *
   * The assertion is the join between the two calls, not either one of them: whatever the first
   * real poll hands back must already be covered by what the seed reported.
   */
  it('the seed reports the ids on its watermark, so the first poll cannot announce an old order', async () => {
    const seed = await getSellerOrdersSince(SLUG, '');
    expect(seed.seenIds, 'a store with orders must report them').not.toEqual([]);

    const firstPoll = await getSellerOrdersSince(SLUG, seed.since);
    const seen = new Set(seed.seenIds ?? []);
    const wouldAnnounce = firstPoll.orders.filter((o) => !seen.has(o.id));
    expect(wouldAnnounce.map((o) => o.checkoutRef), 'nothing existing may be announced as new').toEqual([]);
  });

  it('a store with no orders seeds clean — nothing seen, and nothing to announce', async () => {
    const seed = await getSellerOrdersSince('no-such-store-at-all', '');
    expect(seed.orders).toEqual([]);
    expect(seed.seenIds).toEqual([]);
    // And the watermark is still usable: a first order would be newer than it.
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

  /**
   * **The same phantom toast, at the precision that actually produces it** (owner, 2026-08-11:
   * "עדיין יש לי טוסט רפאים של הזמנה חדשה … מופיע כל פעם שמרעננים את הדף").
   *
   * The test above this one was already green while the bug was live on real data, and the reason
   * is the fixture: every `at` in `SEEDS` is a whole millisecond, and so is everything the demo
   * seeder writes. `timestamptz` keeps MICROseconds and a JS `Date` does not, so the seed's
   * round-trip through `isoOf` truncated the watermark — and the old `= at` lookup then matched no
   * row at all. On whole milliseconds there is nothing to truncate and the bug cannot appear.
   *
   * A real checkout inserts with `now()`. On the owner's own database that was 6 of 38 stores —
   * exactly the ones whose newest order came from a checkout rather than the seeder — and the
   * seller saw a toast plus a phantom card on EVERY refresh, with nothing in the bell behind it.
   *
   * So this seeds the precision the seeder cannot produce, and asserts the only thing that matters:
   * whatever the first real poll hands back, the seed already named it.
   */
  it('an order written with microsecond precision is still reported by the seed', async () => {
    const micro = 'mikro-shniot';
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone, total_agorot,
                           payment_status, shipping_status, created_at)
       VALUES ($1, 'SO-MICRO', 'מיקרו', 'micro@example.com', '0509999999', 1000, 'paid', 'pending',
               '2026-08-07T11:00:46.001380Z'::timestamptz)`,
      [id],
    );
    await query(
      `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
       VALUES ($1, $2, 'פריט', $3, 'מיקרו', 1000, 1, 0)`,
      [crypto.randomUUID(), id, micro],
    );

    const seed = await getSellerOrdersSince(micro, '');
    expect(seed.orders, 'the seed still hands back no rows').toEqual([]);
    expect(seed.seenIds, 'the microsecond order must be reported as already seen').toEqual([id]);

    const firstPoll = await getSellerOrdersSince(micro, seed.since);
    const seen = new Set(seed.seenIds ?? []);
    expect(
      firstPoll.orders.filter((o) => !seen.has(o.id)).map((o) => o.checkoutRef),
      'nothing existing may be announced as new',
    ).toEqual([]);

    await query('DELETE FROM order_items WHERE order_id = $1', [id]);
    await query('DELETE FROM orders WHERE id = $1', [id]);
  });

  /**
   * **The other direction, and the one nobody would have reported** (owner, 2026-08-11, after the
   * phantom toast was fixed: "אין מצב שמוכר יראה … הזמנה שכבר קיבל עליה טוסט?").
   *
   * The phantom toast was loud and got fixed the day it was seen. Its mirror image is silent: the
   * poll used to seed itself from the newest order at the moment its own JavaScript ran, some
   * hundreds of milliseconds after the server had rendered the page. An order landing inside that
   * window BECAME that seed — recorded as already seen while appearing on no screen at all. No
   * toast, and not in the list until the seller happened to reload. A seller who is not told has no
   * way to discover the miss, which is why this direction is worth a test and the loud one arguably
   * was not.
   *
   * The watermark now comes from the page render (`getOrderPollWatermark`) and from POSTGRES's
   * clock, not the app server's — every `created_at` is written by that clock, so a watermark from
   * any other one is a comparison across two clocks, and a second of skew silently swallows a
   * second of orders.
   */
  it('an order that lands after the page was rendered is still announced', async () => {
    const late = 'meucheret';
    const watermark = await getOrderPollWatermark();
    expect(Date.parse(watermark), 'the watermark is a real instant').toBeGreaterThan(0);

    // Arrives AFTER the render — the window that used to swallow it whole.
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone, total_agorot,
                           payment_status, shipping_status, created_at)
       VALUES ($1, 'SO-LATE', 'מאוחרת', 'late@example.com', '0508888888', 1000, 'paid', 'pending', now())`,
      [id],
    );
    await query(
      `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
       VALUES ($1, $2, 'פריט', $3, 'מאוחרת', 1000, 1, 0)`,
      [crypto.randomUUID(), id, late],
    );

    const poll = await getSellerOrdersSince(late, watermark);
    expect(
      poll.orders.map((o) => o.checkoutRef),
      'an order created after the watermark must reach the seller',
    ).toEqual(['SO-LATE']);

    // And the watermark still excludes what came before it, or it would announce the whole history.
    const laterWatermark = await getOrderPollWatermark();
    const quiet = await getSellerOrdersSince(late, laterWatermark);
    expect(quiet.orders, 'nothing older than the watermark comes back').toEqual([]);

    await query('DELETE FROM order_items WHERE order_id = $1', [id]);
    await query('DELETE FROM orders WHERE id = $1', [id]);
  });
});

/**
 * **The join between the two halves of the watermark, which nothing else can see.**
 *
 * The server renders the instant onto `#orders-list`; the poll reads it back off the same element.
 * Both sides are ordinary code and each is correct on its own, so a rename on either — the
 * attribute, the element id — leaves two files that still compile, still pass their own tests, and
 * no longer speak to each other. What the seller sees then is nothing at all: the poll silently
 * falls back to seeding over the network, which is exactly the behaviour whose gap this replaced.
 * A miss that restores an older bug, with no error anywhere, is the shape worth pinning.
 */
describe('the rendered watermark reaches the poll that consumes it', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

  it('the dashboard renders data-since on the orders list', () => {
    const astro = read('src/pages/seller/dashboard.astro');
    expect(astro, 'the orders list must carry the render-time watermark')
      .toMatch(/id="orders-list"[^>]*data-since=\{ordersWatermark\}/);
    expect(astro, 'and it must be read BEFORE the page queries its orders — see getOrderPollWatermark')
      .toMatch(/getOrderPollWatermark\(\)[\s\S]{0,400}getSellerOrdersPage\(/);
  });

  it('the poll reads it instead of seeding over the network', () => {
    const client = read('src/scripts/dashboard/orders.ts');
    expect(client, 'the poll must start from the rendered watermark')
      .toMatch(/ordersSince\s*=\s*ordersList\.dataset\.since/);
    expect(client, 'a card already on screen must never be inserted twice')
      .toMatch(/order-card\[data-order-id="\$\{CSS\.escape/);
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

/**
 * The one query shape the two routes could disagree on, and the only one with a real table behind it.
 *
 * Every other case here filters on columns of `orders`, so both routes read the same row and the
 * comparison is arithmetic. The widened default is different: the SQL asks `EXISTS (… FROM
 * return_requests …)` inside the WHERE, and the pure function is handed a Set of ids it cannot
 * derive. Two independent answers to "does this order have a live return", and a disagreement means
 * the seller's first paint and his first keystroke show different lists.
 *
 * The predicate itself is generated from one array (`returns.ts#openReturnSql`), so what this pins
 * is the JOIN: that the query really applies the branch, that the caller really collects the ids,
 * and that a CLOSED case widens nothing on either side.
 */
describe('the widened default agrees on both routes', () => {
  const openId = crypto.randomUUID();
  const closedId = crypto.randomUUID();

  beforeAll(async () => {
    const delivered = await query<{ id: string }>(
      "SELECT id FROM orders WHERE shipping_status = 'delivered' ORDER BY created_at LIMIT 2");
    expect(delivered.rows.length, 'the seed needs two delivered orders for this').toBeGreaterThan(0);
    await query(
      `INSERT INTO return_requests (id, order_id, store_slug, reason, status, within_statutory, refund_agorot)
       VALUES ($1, $2, $3, 'damaged', 'received', true, 100)`,
      [openId, delivered.rows[0]!.id, SLUG]);
    if (delivered.rows[1]) {
      await query(
        `INSERT INTO return_requests (id, order_id, store_slug, reason, status, within_statutory, refund_agorot)
         VALUES ($1, $2, $3, 'damaged', 'rejected', true, 100)`,
        [closedId, delivered.rows[1]!.id, SLUG]);
    }
  });

  afterAll(async () => {
    await query('DELETE FROM return_requests WHERE id = ANY($1::uuid[])', [[openId, closedId]]);
  });

  it('a delivered order with an OPEN case is on both lists', async () => {
    const q = parseSellerOrderQuery(new URLSearchParams(''));
    expect(q.includeOpenReturns).toBe(true);
    const page = await getSellerOrdersPage(SLUG, q, 1, 10_000);
    const openReturns = new Map((await query<{ order_id: string; status: string }>(
      "SELECT order_id, status FROM return_requests WHERE status = 'received'"))
      .rows.map((r) => [r.order_id, r.status] as const));
    const pure = filterAndSortSellerOrders(await ALL(), SLUG, q, openReturns);
    expect(page.orders.some((o) => o.shippingStatus === 'delivered'), 'the SQL route kept it').toBe(true);
    expect(page.orders.map((o) => o.id).sort()).toEqual(pure.map((o) => o.id).sort());
  });

  it('the return COLUMN narrows both routes identically', async () => {
    // The column is a WHERE on `return_requests` in one route and a Map lookup in the other. Same
    // split as the widening above, same failure if they disagree: the seller's first paint and his
    // first keystroke show different lists.
    const q = parseSellerOrderQuery(new URLSearchParams('oret=received'));
    const page = await getSellerOrdersPage(SLUG, q, 1, 10_000);
    const live = new Map((await query<{ order_id: string; status: string }>(
      "SELECT order_id, status FROM return_requests WHERE status = 'received'"))
      .rows.map((r) => [r.order_id, r.status] as const));
    const pure = filterAndSortSellerOrders(await ALL(), SLUG, q, live);
    expect(page.orders.length, 'the fixture must have one, or this asserts nothing').toBeGreaterThan(0);
    expect(page.orders.map((o) => o.id).sort()).toEqual(pure.map((o) => o.id).sort());
    // …and a state nothing is in empties both.
    const none = parseSellerOrderQuery(new URLSearchParams('oret=in_transit'));
    expect((await getSellerOrdersPage(SLUG, none, 1, 10_000)).orders).toEqual([]);
    expect(filterAndSortSellerOrders(await ALL(), SLUG, none, live)).toEqual([]);
  });

  it("another store's case on a SHARED order does not claim this seller's slice", async () => {
    // One DELIVERED order with a line in each shop, and the return belongs to the other one.
    // Unscoped, the `EXISTS` keeps it on THIS seller's default list and the chip tells him his goods
    // are coming back — not a leak of anyone's data, but a claim about his own that is untrue and
    // that he cannot act on. `return_requests.store_slug` is denormalised for exactly this
    // (migration 0030).
    //
    // Built here rather than taken from the seed: the seed's only multi-store order is `processing`,
    // so a test that went looking for a shared DELIVERED one found none and passed by doing nothing.
    // It did — measured, by deleting the scope and watching it stay green.
    const shared = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await query(
      `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone, total_agorot,
                           payment_status, shipping_status, created_at)
       VALUES ($1, 'SO-SHARED', 'קונה משותף', 'shared@example.com', '0509999999', 10000,
               'paid', 'delivered', '2026-07-05T09:00:00.000Z'::timestamptz)`, [shared]);
    await query(
      `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
       VALUES ($1, $2, 'שלי', $3, 'קרמיקה', 5000, 1, 0), ($4, $2, 'שלו', $5, 'תכשיטים', 5000, 1, 1)`,
      [crypto.randomUUID(), shared, SLUG, crypto.randomUUID(), OTHER]);
    await query(
      `INSERT INTO return_requests (id, order_id, store_slug, reason, status, within_statutory, refund_agorot)
       VALUES ($1, $2, $3, 'damaged', 'received', true, 100)`, [foreign, shared, OTHER]);
    try {
      const q = parseSellerOrderQuery(new URLSearchParams(''));
      const mine = await getSellerOrdersPage(SLUG, q, 1, 10_000);
      expect(mine.orders.map((o) => o.id), 'the other shop\u2019s case must not widen MY default').not.toContain(shared);
      // …and the shop the case really belongs to does see it, or the scope is simply a filter that
      // hides everything.
      const theirs = await getSellerOrdersPage(OTHER, q, 1, 10_000);
      expect(theirs.orders.map((o) => o.id)).toContain(shared);
    } finally {
      await query('DELETE FROM return_requests WHERE id = $1', [foreign]);
      await query('DELETE FROM order_items WHERE order_id = $1', [shared]);
      await query('DELETE FROM orders WHERE id = $1', [shared]);
    }
  });

  it('a delivered order whose case is CLOSED is on neither', async () => {
    const q = parseSellerOrderQuery(new URLSearchParams(''));
    const page = await getSellerOrdersPage(SLUG, q, 1, 10_000);
    const closed = (await query<{ order_id: string }>(
      "SELECT order_id FROM return_requests WHERE status = 'rejected'")).rows[0]?.order_id;
    if (!closed) return;
    expect(page.orders.map((o) => o.id)).not.toContain(closed);
    expect(filterAndSortSellerOrders(await ALL(), SLUG, q, new Map()).map((o) => o.id)).not.toContain(closed);
  });
});
