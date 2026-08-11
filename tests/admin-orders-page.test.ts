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
  /** SQL expressions, not literals: the payout classification is measured against TODAY, so a fixed
   *  date would silently change meaning as the calendar moves. `null` leaves the column NULL. */
  paidAt?: string;
  deliveredAt?: string;
  /** Set on every slice of the order — the pickup arm of the hold rule keys off it. */
  deliveryMethod?: 'pickup' | 'courier';
}

const SEEDS: Seed[] = [
  { ref: 'CR-1', buyer: 'דנה כהן',  email: 'dana@example.com', phone: '0501111111', total: 12000, payment: 'paid',    shipping: 'delivered',  at: '2026-07-01T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }] },
  { ref: 'CR-2', buyer: 'יוסי לוי', email: 'yossi@example.com', phone: '0502222222', total: 5500,  payment: 'paid',    shipping: 'pending',    at: '2026-07-02T09:00:00.000Z', stores: [{ slug: 'tachshitim', name: 'תכשיטים' }] },
  { ref: 'CR-3', buyer: 'דנה לוי',  email: 'dana2@example.com', phone: '0503333333', total: 99000, payment: 'pending', shipping: 'processing', at: '2026-07-03T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }, { slug: 'tachshitim', name: 'תכשיטים' }] },
  { ref: 'CR-4', buyer: 'רון גל',   email: 'ron@example.com',   phone: '0504444444', total: 700,   payment: 'failed',  shipping: 'cancelled',  at: '2026-07-04T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }] },
  { ref: 'CR-5', buyer: 'שרה מור',  email: 'sara@example.com',  phone: '0505555555', total: 3300,  payment: 'paid',    shipping: 'shipped',    at: '2026-07-05T09:00:00.000Z', stores: [{ slug: 'tachshitim', name: 'תכשיטים' }] },
  // Same instant as CR-5 — the tie-break is what stops the two swapping places between loads.
  { ref: 'CR-6', buyer: 'שרה מור',  email: 'sara@example.com',  phone: '0505555555', total: 3300,  payment: 'paid',    shipping: 'ready',      at: '2026-07-05T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }] },
  // ── The payout-state cases (owner, 2026-08-11: the admin gained the seller's "שחרור הכסף"
  // filter). The five values are a SECOND spelling of the hold rule — JS on the seller's screen,
  // SQL in this query — so the fixture has to reach every one of them or the parity assertion is
  // vacuous exactly where it matters. The six seeds above cover `none` (CR-4, cancelled) and
  // `unshipped` (CR-2, CR-6: 'ready' with no pickup method is still the courier milestone).
  { ref: 'CR-7', buyer: 'עדי בר',  email: 'adi@example.com',  phone: '0506666666', total: 4200, payment: 'paid', shipping: 'delivered', at: '2026-07-06T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }],
    paidAt: "now() - interval '120 days'", deliveredAt: "now() - interval '119 days'" },
  { ref: 'CR-8', buyer: 'נועה שי', email: 'noa@example.com',  phone: '0507777777', total: 8100, payment: 'paid', shipping: 'shipped',   at: '2026-07-07T09:00:00.000Z', stores: [{ slug: 'tachshitim', name: 'תכשיטים' }],
    paidAt: "now() - interval '1 day'" },
  // Self-pickup: 'ready' IS the milestone here, so its clock runs while CR-6's does not — the one
  // case where the two arms of the CASE disagree, and therefore the one worth a row of its own.
  { ref: 'CR-9', buyer: 'גיל דור', email: 'gil@example.com',  phone: '0508888888', total: 2400, payment: 'paid', shipping: 'ready',     at: '2026-07-08T09:00:00.000Z', stores: [{ slug: 'keramika', name: 'קרמיקה' }],
    paidAt: "now() - interval '1 day'", deliveryMethod: 'pickup' },
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
                           payment_status, shipping_status, created_at, paid_at, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, ${s.paidAt ?? 'NULL'}, ${s.deliveredAt ?? 'NULL'})`,
      [id, s.ref, s.buyer, s.email, s.phone, s.total, s.payment, s.shipping, s.at],
    );
    for (const [i, store] of s.stores.entries()) {
      await query(
        `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
         VALUES ($1, $2, 'פריט', $3, $4, $5, 1, $6)`,
        [crypto.randomUUID(), id, store.slug, store.name, Math.round(s.total / s.stores.length), i],
      );
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, delivery_method)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, store.slug, store.name, Math.round(s.total / s.stores.length), s.deliveryMethod ?? null],
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

  /**
   * The payout filter, value by value — and every one of them asserted BY NAME rather than only
   * through `bothAgree`. Parity alone would pass if both routes were wrong in the same direction
   * (a `NOT` dropped on both sides classifies everything as one state and the two lists still
   * match), so each case also names the order it must find.
   */
  describe('filtering by payout state', () => {
    const CASES: Array<[string, string[]]> = [
      ['unshipped',   ['CR-2', 'CR-6']],
      ['undelivered', ['CR-8', 'CR-9']],
      ['released',    ['CR-7']],
      ['none',        ['CR-3', 'CR-4']],
    ];
    for (const [state, refs] of CASES) {
      it(`${state} finds exactly the orders in that state`, async () => {
        const rows = await bothAgree({ payout: [state] }, `payout=${state}`);
        expect(rows.map((o) => o.checkoutRef).sort()).toEqual(refs);
      });
    }

    it('the five states partition every order — none missing, none counted twice', async () => {
      const all = await ALL();
      const seen = new Map<string, number>();
      for (const state of ['unshipped', 'undelivered', 'window', 'released', 'none']) {
        for (const o of await bothAgree({ payout: [state] }, `partition:${state}`)) {
          seen.set(o.id, (seen.get(o.id) ?? 0) + 1);
        }
      }
      expect(seen.size, 'every order lands in some state').toBe(all.length);
      expect([...seen.values()].filter((n) => n !== 1), 'no order in two states').toEqual([]);
    });

    it('several states at once are an OR, like every other filter here', async () => {
      const rows = await bothAgree({ payout: ['released', 'none'] }, 'payout=released,none');
      expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['CR-3', 'CR-4', 'CR-7']);
    });
  });

  it('filtering by shipping status', async () => {
    const rows = await bothAgree({ shippingStatus: ['pending', 'shipped'] }, 'shipping filter');
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['CR-2', 'CR-5', 'CR-8']);
  });

  it('filtering by payment status', async () => {
    const rows = await bothAgree({ paymentStatus: ['failed'] }, 'payment filter');
    expect(rows.map((o) => o.checkoutRef)).toEqual(['CR-4']);
  });

  it('filtering by store NAME, which is what the dropdown carries', async () => {
    const rows = await bothAgree({ store: ['תכשיטים'] }, 'store filter');
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['CR-2', 'CR-3', 'CR-5', 'CR-8']);
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
    // Derived from the fixture rather than written as a number: a seed added for another case must
    // not turn a paging assertion red for a reason that has nothing to do with paging.
    const pages = Math.ceil(SEEDS.length / 2);
    for (let page = 1; page <= pages; page += 1) {
      const p = await getAdminOrdersPage({ sortCol: 'date', sortDir: 'desc' }, page, 2);
      expect(p.page).toBe(page);
      expect(p.totalPages).toBe(pages);
      expect(p.total).toBe(SEEDS.length);
      seen.push(...p.orders.map((o) => o.id));
    }
    expect(seen).toEqual(all);
  });

  it('clamps a page past the end rather than answering an empty list', async () => {
    const p = await getAdminOrdersPage({}, 99, 2);
    expect(p.page).toBe(Math.ceil(SEEDS.length / 2));
    expect(p.orders.length).toBeGreaterThan(0);
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
    expect(page.orders.map((o) => o.checkoutRef).sort()).toEqual(['CR-4', 'CR-5', 'CR-6', 'CR-7', 'CR-8', 'CR-9']);
  });

  it('composes with a filter rather than replacing it', async () => {
    const page = await getAdminOrdersPage({ newSince: '2026-07-03T12:00:00.000Z', paymentStatus: ['paid'] }, 1, 50);
    expect(page.orders.map((o) => o.checkoutRef).sort()).toEqual(['CR-5', 'CR-6', 'CR-7', 'CR-8', 'CR-9']);
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
