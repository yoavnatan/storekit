/**
 * The admin Orders tab's page, against a real Postgres — and against the JS it replaced.
 *
 * `getAllOrders()` + `filterAndSortOrders()` + `paginate()` became one `WHERE`/`ORDER BY`/`LIMIT`
 * (DB_MIGRATION_PLAN.md §3). Reading every order the platform has ever taken to render fifteen
 * rows is the shape §3 exists to remove — but the rules themselves (what the search box matches,
 * which sorts exist, how a tie breaks) had to survive the move exactly, because an admin who
 * searches for an order and is told it does not exist has no way to tell a filter bug from a
 * missing order.
 *
 * So every case below asserts the query against `filterAndSortOrders` over the SAME rows. The pure
 * function is not dead code: it is the definition, it is unit-testable without a database, and it
 * is what makes "the query still means what it meant" a thing a test can say.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getAdminOrdersPage, type Order } from '../src/lib/orders.js';
import { filterAndSortOrders, parseOrderQuery, type AdminOrderQuery } from '../src/lib/admin-orders-filter.js';

const ALL = async (): Promise<Order[]> => (await getAdminOrdersPage({}, 1, 10_000)).orders;

interface Seed {
  ref: string;
  buyer: string;
  email: string;
  phone: string;
  total: number;
  payment: 'pending' | 'paid' | 'failed';
  shipping: Order['shippingStatus'];
  at: string;
  stores: Array<{ slug: string; name: string }>;
}

const SEEDS: Seed[] = [
  { ref: 'CR-1', buyer: 'דנה כהן',  email: 'dana@example.com', phone: '0501111111', total: 12000, payment: 'paid',    shipping: 'delivered',  at: '2026-07-01T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }] },
  { ref: 'CR-2', buyer: 'יוסי לוי', email: 'yossi@example.com', phone: '0502222222', total: 5500,  payment: 'paid',    shipping: 'pending',    at: '2026-07-02T09:00:00.000Z', stores: [{ slug: 'tachshitim', name: 'תכשיטים' }] },
  { ref: 'CR-3', buyer: 'דנה לוי',  email: 'dana2@example.com', phone: '0503333333', total: 99000, payment: 'pending', shipping: 'processing', at: '2026-07-03T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }, { slug: 'tachshitim', name: 'תכשיטים' }] },
  { ref: 'CR-4', buyer: 'רון גל',   email: 'ron@example.com',   phone: '0504444444', total: 700,   payment: 'failed',  shipping: 'cancelled',  at: '2026-07-04T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }] },
  { ref: 'CR-5', buyer: 'שרה מור',  email: 'sara@example.com',  phone: '0505555555', total: 3300,  payment: 'paid',    shipping: 'shipped',    at: '2026-07-05T09:00:00.000Z', stores: [{ slug: 'tachshitim', name: 'תכשיטים' }] },
  // Same instant as CR-5 — the tie-break is what stops the two swapping places between loads.
  { ref: 'CR-6', buyer: 'שרה מור',  email: 'sara@example.com',  phone: '0505555555', total: 3300,  payment: 'paid',    shipping: 'ready',      at: '2026-07-05T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }] },
];

beforeAll(async () => {
  // A clean journal for this file: the fixture's own orders would make "the two agree" true while
  // saying nothing about the cases below.
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM money_events');
  await query('DELETE FROM orders');
  for (const s of SEEDS) {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone, total_agorot,
                           payment_status, shipping_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [id, s.ref, s.buyer, s.email, s.phone, s.total, s.payment, s.shipping, s.at],
    );
    for (const [i, store] of s.stores.entries()) {
      await query(
        `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
         VALUES ($1, $2, 'פריט', $3, $4, $5, 1, $6)`,
        [crypto.randomUUID(), id, store.slug, store.name, Math.round(s.total / s.stores.length), i],
      );
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot)
         VALUES ($1, $2, $3, $4)`,
        [id, store.slug, store.name, Math.round(s.total / s.stores.length)],
      );
    }
  }
});

/** Run both routes over the same rows and require the same list of order ids. */
async function bothAgree(q: AdminOrderQuery, label: string): Promise<Order[]> {
  const page = await getAdminOrdersPage(q, 1, 10_000);
  const pure = filterAndSortOrders(await ALL(), q);
  expect(page.orders.map((o) => o.id), `${label}: query vs filterAndSortOrders`).toEqual(pure.map((o) => o.id));
  expect(page.total, `${label}: total`).toBe(pure.length);
  return page.orders;
}

describe('getAdminOrdersPage agrees with filterAndSortOrders', () => {
  it('with no filters at all', async () => {
    const rows = await bothAgree({}, 'unfiltered');
    expect(rows).toHaveLength(SEEDS.length);
  });

  for (const sortCol of ['date', 'amount', 'shippingStatus'] as const) {
    for (const sortDir of ['asc', 'desc'] as const) {
      it(`sorting by ${sortCol}:${sortDir}`, async () => {
        await bothAgree({ sortCol, sortDir }, `${sortCol}:${sortDir}`);
      });
    }
  }

  it('filtering by shipping status', async () => {
    const rows = await bothAgree({ shippingStatus: ['pending', 'shipped'] }, 'shipping filter');
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['CR-2', 'CR-5']);
  });

  it('filtering by payment status', async () => {
    const rows = await bothAgree({ paymentStatus: ['failed'] }, 'payment filter');
    expect(rows.map((o) => o.checkoutRef)).toEqual(['CR-4']);
  });

  it('filtering by store NAME, which is what the dropdown carries', async () => {
    const rows = await bothAgree({ store: ['תכשיטים'] }, 'store filter');
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['CR-2', 'CR-3', 'CR-5']);
  });

  for (const q of ['דנה', 'dana@example.com', '0503333333', 'CR-4', 'קרמיקה', 'לא קיים']) {
    it(`free-text search for "${q}"`, async () => {
      await bothAgree({ q }, `search ${q}`);
    });
  }

  it('combines a search with a status filter instead of replacing it', async () => {
    const rows = await bothAgree({ q: 'דנה', paymentStatus: ['paid'] }, 'search + filter');
    expect(rows.map((o) => o.checkoutRef)).toEqual(['CR-1']);
  });

  it('matches case-insensitively, as the JS lowercases both sides', async () => {
    await bothAgree({ q: 'DANA@EXAMPLE.COM' }, 'uppercase search');
    expect((await getAdminOrdersPage({ q: 'DANA@EXAMPLE.COM' }, 1, 50)).total).toBe(1);
  });
});

describe('paging', () => {
  it('slices without changing the order, and every page is disjoint', async () => {
    const all = (await bothAgree({ sortCol: 'date', sortDir: 'desc' }, 'paging base')).map((o) => o.id);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const p = await getAdminOrdersPage({ sortCol: 'date', sortDir: 'desc' }, page, 2);
      expect(p.page).toBe(page);
      expect(p.totalPages).toBe(3);
      expect(p.total).toBe(SEEDS.length);
      seen.push(...p.orders.map((o) => o.id));
    }
    expect(seen).toEqual(all);
  });

  it('clamps a page past the end rather than answering an empty list', async () => {
    const p = await getAdminOrdersPage({}, 99, 2);
    expect(p.page).toBe(3);
    expect(p.orders).toHaveLength(2);
  });

  it('breaks a shared timestamp on a stable key, so two loads agree', async () => {
    // CR-5 and CR-6 share `created_at` to the microsecond (§7.13).
    const once = (await getAdminOrdersPage({ sortCol: 'date', sortDir: 'desc' }, 1, 50)).orders.map((o) => o.id);
    const twice = (await getAdminOrdersPage({ sortCol: 'date', sortDir: 'desc' }, 1, 50)).orders.map((o) => o.id);
    expect(once).toEqual(twice);
  });
});

describe('"new since you last opened the tab"', () => {
  it('keeps only orders after the boundary', async () => {
    const page = await getAdminOrdersPage({ newSince: '2026-07-03T12:00:00.000Z' }, 1, 50);
    expect(page.orders.map((o) => o.checkoutRef).sort()).toEqual(['CR-4', 'CR-5', 'CR-6']);
  });

  it('composes with a filter rather than replacing it', async () => {
    const page = await getAdminOrdersPage({ newSince: '2026-07-03T12:00:00.000Z', paymentStatus: ['paid'] }, 1, 50);
    expect(page.orders.map((o) => o.checkoutRef).sort()).toEqual(['CR-5', 'CR-6']);
  });
});

describe('the query params still mean what they meant', () => {
  it('parseOrderQuery feeds the query, and an unknown sort falls back', () => {
    const parsed = parseOrderQuery(new URLSearchParams('oq=%20%D7%93%D7%A0%D7%94%20&osort=nonsense:desc&oship=pending,shipped&opay=paid'));
    expect(parsed.q).toBe('דנה');
    expect(parsed.sortCol).toBe('date');
    expect(parsed.sortDir).toBe('desc');
    expect(parsed.shippingStatus).toEqual(['pending', 'shipped']);
    expect(parsed.paymentStatus).toEqual(['paid']);
  });
});
