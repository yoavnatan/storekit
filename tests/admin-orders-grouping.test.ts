/**
 * The admin Orders tab pages by PURCHASE, not by order row.
 *
 * A cart spanning five stores is five rows in `orders` — deliberately, so each seller owns an
 * isolated order. Until 2026-08-07 the admin tab showed those as five separate orders: five cards,
 * five "order numbers", five totals, for one thing the buyer bought once (owner). This file is the
 * proof that the page is now built out of `checkout-group.ts` keys, and it needs its own fixture:
 * `admin-orders-page.test.ts` seeds one row per checkout ref, so grouping is a no-op there and
 * every assertion in it would stay green with the grouping removed.
 *
 * The property that actually protects the money on the card is the LAST one here — a filter
 * selects which purchases to show, never which slices of them. Filtering the rows instead would
 * draw a card whose total is the sum of the matching slices, which is not a narrower answer, it is
 * a wrong number.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import { getAdminOrdersPage, type Order } from '../src/lib/orders.js';
import { checkoutGroupKey } from '../src/lib/checkout-group.js';

interface Slice {
  store: string;
  total: number;
  shipping: Order['shippingStatus'];
}
interface Purchase {
  ref: string;
  payRef: string | null;
  buyer: string;
  at: string;
  payment: 'pending' | 'paid' | 'failed';
  slices: Slice[];
}

/** One five-store checkout (the shape from the owner's own 500), two ordinary single-store ones,
 *  and one legacy row with no checkout ref at all. */
const PURCHASES: Purchase[] = [
  {
    ref: 'MULTI-1', payRef: 'MOCK-MULTI-1', buyer: 'קונה רב־חנויות', at: '2026-07-10T09:00:00.000Z', payment: 'paid',
    slices: [
      { store: 'aksesori', total: 1000, shipping: 'delivered' },
      { store: 'megamart', total: 2000, shipping: 'shipped' },
      { store: 'bazaar', total: 3000, shipping: 'pending' },
      { store: 'garage', total: 4000, shipping: 'processing' },
      { store: 'roast', total: 5000, shipping: 'ready' },
    ],
  },
  { ref: 'SOLO-1', payRef: 'MOCK-SOLO-1', buyer: 'קונה יחיד', at: '2026-07-11T09:00:00.000Z', payment: 'paid', slices: [{ store: 'keramika', total: 7000, shipping: 'delivered' }] },
  { ref: 'SOLO-2', payRef: 'MOCK-SOLO-2', buyer: 'קונה שני', at: '2026-07-12T09:00:00.000Z', payment: 'paid', slices: [{ store: 'keramika', total: 500, shipping: 'pending' }] },
  // No checkout_ref — nothing writes these today, but rows predate the field and each must stay
  // its OWN purchase rather than collapsing with every other ref-less row into one giant card.
  { ref: '', payRef: null, buyer: 'ישן א', at: '2026-07-13T09:00:00.000Z', payment: 'paid', slices: [{ store: 'keramika', total: 100, shipping: 'pending' }] },
  { ref: '', payRef: null, buyer: 'ישן ב', at: '2026-07-14T09:00:00.000Z', payment: 'paid', slices: [{ store: 'keramika', total: 200, shipping: 'pending' }] },
];

beforeAll(async () => {
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM money_events');
  await query('DELETE FROM orders');
  for (const p of PURCHASES) {
    for (const [i, s] of p.slices.entries()) {
      const id = crypto.randomUUID();
      await query(
        `INSERT INTO orders (id, checkout_ref, payment_ref, buyer_name, buyer_email, buyer_phone,
                             total_agorot, payment_status, shipping_status, created_at)
         VALUES ($1, $2, $3, $4, 'b@example.test', '050', $5, $6, $7, $8::timestamptz)`,
        // Every slice of one checkout carries the SAME payment ref — one charge, N rows. That is
        // the arrangement migration 0017 had to make legal, and it is what the key pairs on.
        [id, p.ref || null, p.payRef, p.buyer, s.total, p.payment, s.shipping, p.at],
      );
      await query(
        `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
         VALUES ($1, $2, 'פריט', $3, $4, $5, 1, $6)`,
        [crypto.randomUUID(), id, s.store, s.store, s.total, i],
      );
      await query(
        `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot)
         VALUES ($1, $2, $3, $4)`,
        [id, s.store, s.store, s.total],
      );
    }
  }
});

/** The page's purchases, in page order, as the panel groups them. */
function groupsOf(orders: Order[]): Order[][] {
  const out: Order[][] = [];
  const byKey = new Map<string, Order[]>();
  for (const o of orders) {
    const key = checkoutGroupKey(o);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(o);
    else { const fresh = [o]; byKey.set(key, fresh); out.push(fresh); }
  }
  return out;
}

describe('the page counts purchases', () => {
  it('counts a five-store checkout as ONE, not as five', async () => {
    const p = await getAdminOrdersPage({}, 1, 50);
    // 5 purchases seeded: the multi-store one, two solos, two ref-less legacy rows.
    expect(p.total).toBe(5);
    expect(p.totalUnfiltered).toBe(5);
    // …while still returning all nine ROWS, because the card renders every slice.
    expect(p.orders).toHaveLength(9);
    expect(groupsOf(p.orders)).toHaveLength(5);
  });

  it('keeps a ref-less legacy row as its own purchase', async () => {
    const p = await getAdminOrdersPage({}, 1, 50);
    const legacy = groupsOf(p.orders).filter((g) => !g[0]!.checkoutRef);
    expect(legacy).toHaveLength(2);
    expect(legacy.every((g) => g.length === 1)).toBe(true);
  });
});

describe('paging is by purchase', () => {
  it('never splits one purchase across two pages', async () => {
    const seen = new Set<string>();
    let rows = 0;
    for (let page = 1; page <= 3; page += 1) {
      const p = await getAdminOrdersPage({ sortCol: 'date', sortDir: 'desc' }, page, 2);
      expect(p.totalPages).toBe(3);
      rows += p.orders.length;
      for (const g of groupsOf(p.orders)) {
        const key = checkoutGroupKey(g[0]!);
        // The same purchase appearing on two pages is the failure this is here for: it would
        // double-count its total for anyone adding the pages up.
        expect(seen.has(key), `purchase ${key} appeared on more than one page`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(5);
    expect(rows).toBe(9);
  });

  it('puts two purchases on a page of two, however many rows that is', async () => {
    const p = await getAdminOrdersPage({ sortCol: 'date', sortDir: 'asc' }, 1, 2);
    expect(groupsOf(p.orders)).toHaveLength(2);
    // Oldest first: the five-store checkout then SOLO-1 — six rows for two cards.
    expect(p.orders).toHaveLength(6);
  });
});

describe('sorting reads the whole purchase', () => {
  it('sorts by the SUM of the slices, not by any one of them', async () => {
    const p = await getAdminOrdersPage({ sortCol: 'amount', sortDir: 'desc' }, 1, 50);
    const first = groupsOf(p.orders)[0]!;
    // The multi-store purchase totals 15,000 — more than SOLO-1's 7,000 — while its largest single
    // slice is 5,000, which is LESS. Sorting rows would have put SOLO-1 first.
    expect(first[0]!.checkoutRef).toBe('MULTI-1');
    expect(first.reduce((s, o) => s + o.totalAgorot, 0)).toBe(15_000);
  });

  it('sorts by the LEAST advanced slice, because that is what the order is waiting on', async () => {
    const p = await getAdminOrdersPage({ sortCol: 'shippingStatus', sortDir: 'asc' }, 1, 50);
    const refs = groupsOf(p.orders).map((g) => g[0]!.checkoutRef ?? '(legacy)');
    // Not "MULTI-1 is first" — several purchases are pending and the tie falls to the date, which
    // is a different rule and not this one's business. The property is that MULTI-1 sorts among
    // the PENDING ones (its least advanced slice) and therefore ahead of the fully delivered
    // SOLO-1, even though it also holds a delivered slice of its own.
    expect(refs.indexOf('MULTI-1')).toBeLessThan(refs.indexOf('SOLO-1'));
    // And SOLO-1, delivered outright, is last of all.
    expect(refs[refs.length - 1]).toBe('SOLO-1');
  });
});

describe('a filter chooses PURCHASES, never slices', () => {
  it('returns every slice of a purchase one of whose slices matched', async () => {
    // 'delivered' matches exactly one slice of MULTI-1 (aksesori) and all of SOLO-1.
    const p = await getAdminOrdersPage({ shippingStatus: ['delivered'] }, 1, 50);
    const groups = groupsOf(p.orders);
    expect(groups).toHaveLength(2);
    const multi = groups.find((g) => g[0]!.checkoutRef === 'MULTI-1')!;
    // All five come back. Returning only the delivered slice would draw a card reading ₪10.00
    // for a purchase the buyer paid ₪150.00 for — the reason this is the load-bearing test here.
    expect(multi).toHaveLength(5);
    expect(multi.reduce((s, o) => s + o.totalAgorot, 0)).toBe(15_000);
  });

  it('matches a store filter on any slice and still returns the whole purchase', async () => {
    const p = await getAdminOrdersPage({ store: ['roast'] }, 1, 50);
    expect(p.total).toBe(1);
    expect(p.orders).toHaveLength(5);
  });

  it('matches the search haystack on any slice', async () => {
    const p = await getAdminOrdersPage({ q: 'garage' }, 1, 50);
    expect(p.total).toBe(1);
    expect(p.orders.map((o) => o.checkoutRef)).toEqual(Array(5).fill('MULTI-1'));
  });

  it('counts a purchase as new when any slice is new', async () => {
    const p = await getAdminOrdersPage({ newSince: '2026-07-11T12:00:00.000Z' }, 1, 50);
    // SOLO-2 and the two legacy rows are after the boundary; MULTI-1 and SOLO-1 are before it.
    expect(p.total).toBe(3);
  });
});
