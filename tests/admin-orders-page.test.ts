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
import {
  filterAndSortOrders, parseOrderQuery, resolveOrderQuery, sortSellerOptions,
  type AdminOrderQuery,
} from '../src/lib/admin-orders-filter.js';
import { getOrderSellerOptions } from '../src/lib/order-reporting.js';

// The repo's own fixture (tests/fixtures/db-data): 'keramika' belongs to Dana, 'tachshitim' to
// Yossi. Two sellers with one store each is exactly the case the store filter could already
// answer — which is why the seller cases below lean on the two things it cannot: a retired slug,
// and one seller's whole history in a single tick.
const DANA = '11111111-1111-4111-8111-000000000001';
const YOSSI = '11111111-1111-4111-8111-000000000002';
const KERAMIKA_STORE = '22222222-2222-4222-8222-000000000001';
/** A slug 'keramika' used to answer to. Only CR-10 was filed under it. */
const RENAMED_SLUG = 'keramika-was';

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
  // Filed under a slug the store no longer answers to — `order_items.store_slug` is a SNAPSHOT, so
  // this is what every order placed before a rename looks like forever. It exists for the "מוכר/ת"
  // filter: resolving a seller through `stores.slug` alone would find CR-1 and lose this one, and
  // an admin would see a seller's history silently begin on the day they renamed a shop. Same
  // shape as CR-1 in every other respect so it lands in the same payout state and dated before the
  // "new since" boundary, so no assertion above has to move to make room for it.
  { ref: 'CR-10', buyer: 'תמר אור', email: 'tamar@example.com', phone: '0509999999', total: 1500, payment: 'paid', shipping: 'delivered', at: '2026-07-02T10:00:00.000Z', stores: [{ slug: RENAMED_SLUG, name: 'קרמיקה' }] },
];

beforeAll(async () => {
  // A clean journal for this file: the fixture's own orders would make "the two agree" true while
  // saying nothing about the cases below.
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM money_events');
  await query('DELETE FROM orders');
  // The rename CR-10 was placed before. Written here rather than through `renameStoreSlug` on
  // purpose: what is under test is the READ, and it must work off the row the rename leaves behind
  // whoever wrote it.
  await query(
    `INSERT INTO store_previous_slugs (slug, store_id) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET store_id = EXCLUDED.store_id`,
    [RENAMED_SLUG, KERAMIKA_STORE],
  );
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

  it('filtering by store SLUG, which is what the seller filter resolves to', async () => {
    const rows = await bothAgree({ storeSlug: ['tachshitim'] }, 'slug filter');
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(['CR-2', 'CR-3', 'CR-5', 'CR-8']);
  });

  it('several slugs are an OR, and a purchase spanning two of them is shown whole', async () => {
    // CR-3 is one checkout across both stores. It appears once, not twice, and with both of its
    // lines — the "ANY line matches, then show the whole purchase" rule the payout filter states.
    const rows = await bothAgree({ storeSlug: ['keramika', 'tachshitim'] }, 'both slugs');
    expect(rows.filter((o) => o.checkoutRef === 'CR-3')).toHaveLength(1);
    expect(rows.map((o) => o.checkoutRef).sort()).toEqual(
      ['CR-1', 'CR-2', 'CR-3', 'CR-4', 'CR-5', 'CR-6', 'CR-7', 'CR-8', 'CR-9'],
    );
  });

  it('combines the slug filter with a status filter rather than replacing it', async () => {
    const rows = await bothAgree({ storeSlug: ['keramika'], paymentStatus: ['failed'] }, 'slug + payment');
    expect(rows.map((o) => o.checkoutRef)).toEqual(['CR-4']);
  });

  it('a slug nobody sold under finds nothing — it does not fall back to everything', async () => {
    const rows = await bothAgree({ storeSlug: ['no-such-store'] }, 'unknown slug');
    expect(rows).toEqual([]);
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

  it('reads oseller, and leaves it as ids for the page to resolve', () => {
    const parsed = parseOrderQuery(new URLSearchParams(`oseller=${DANA},${YOSSI}`));
    expect(parsed.seller).toEqual([DANA, YOSSI]);
    // The engines never see `seller`; `resolveOrderQuery` is what produces what they do see.
    expect('storeSlug' in parsed).toBe(false);
  });
});

/**
 * "Show me this seller's orders" — the question the store filter beside it cannot answer, because a
 * seller is an ACCOUNT and may run several shops under several names (owner, 2026-08-11).
 *
 * The two halves are tested apart because they fail apart: the option list is a query about who
 * owns which slug, and the filter is the same slug predicate the cases above already pin.
 */
describe('the "מוכר/ת" filter', () => {
  it('lists only sellers who have actually sold, with every slug their orders were filed under', async () => {
    const options = await getOrderSellerOptions();
    expect(options.map((o) => o.id).sort()).toEqual([DANA, YOSSI].sort());
    const dana = options.find((o) => o.id === DANA)!;
    // The retired slug is IN the list. Without it, CR-10 — an order Dana really took — would be
    // unreachable by her name for the rest of the platform's life.
    expect([...dana.storeSlugs].sort()).toEqual(['keramika', RENAMED_SLUG].sort());
    expect(options.find((o) => o.id === YOSSI)!.storeSlugs).toEqual(['tachshitim']);
  });

  it('resolves a seller to their slugs, and finds the orders filed under a slug they retired', async () => {
    const options = await getOrderSellerOptions();
    const query = resolveOrderQuery(parseOrderQuery(new URLSearchParams(`oseller=${DANA}`)), options);
    const rows = await bothAgree(query, 'seller=dana');
    expect(rows.map((o) => o.checkoutRef).sort())
      .toEqual(['CR-1', 'CR-10', 'CR-3', 'CR-4', 'CR-6', 'CR-7', 'CR-9']);
  });

  it('two sellers are an OR over the union of their slugs', async () => {
    const options = await getOrderSellerOptions();
    const query = resolveOrderQuery(parseOrderQuery(new URLSearchParams(`oseller=${DANA},${YOSSI}`)), options);
    expect((await bothAgree(query, 'seller=both')).length).toBe(SEEDS.length);
  });

  it('an id naming no seller narrows nothing, rather than emptying the tab', () => {
    // The same call a stale link makes. `payout` already whitelists for this reason: a value that
    // means nothing must read as "no filter", never as "the platform has no orders".
    const parsed = parseOrderQuery(new URLSearchParams('oseller=00000000-0000-4000-8000-000000000000'));
    expect(resolveOrderQuery(parsed, [])).not.toHaveProperty('storeSlug');
  });

  it('keeps two sellers apart when only their ids differ', () => {
    const twins = [
      { id: DANA, name: 'דנה', email: 'a@example.com', storeSlugs: ['a'] },
      { id: YOSSI, name: 'דנה', email: 'b@example.com', storeSlugs: ['b'] },
    ];
    const parsed = parseOrderQuery(new URLSearchParams(`oseller=${YOSSI}`));
    expect(resolveOrderQuery(parsed, twins).storeSlug).toEqual(['b']);
    // And they sort on the email, so the menu draws them in a stable order rather than whichever
    // one the database happened to return first.
    expect(sortSellerOptions(twins).map((s) => s.email)).toEqual(['a@example.com', 'b@example.com']);
  });
});
