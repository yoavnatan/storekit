/**
 * Orders, against a real Postgres — the fifth module moved off `data/*.json`
 * (DB_MIGRATION_PLAN.md §8 stage 2), and the one that carries the money.
 *
 * **Written from scratch, for the fifth time, for the fifth time for the same reason.** §9.1 ("the
 * existing tests pass unchanged") only proves something when a test could have failed, and the
 * coverage this module had was of the pure predicates sitting beside it — `countsAsRevenue`,
 * `purchasedCountsFrom`, `orderBelongsToStore`, the query/filter/sort helpers — every one of them
 * fed hand-built `Order` objects. Nothing read or wrote a single order. A replacement returning an
 * empty list for every store, losing every line of every order, or writing the total into the
 * shipping column would have left the suite green.
 *
 * What it pins, beyond "the answers did not change":
 *   · integer agorot survive the round trip EXACTLY, including the amounts that had no exact ILS
 *     float (§7.7) — the whole reason the unit flipped;
 *   · the two halves of `orderBelongsToStore` are both in the SQL, so a seller cannot lose an order
 *     the predicate says is theirs;
 *   · the SQL revenue rule and the JS one give the same answer, because they are two spellings of
 *     one table (order-status-rules.ts) and this is where they would drift;
 *   · a patch of one child does not erase the other — the trap `updateProduct` hit with its two
 *     partial variant maps, in the same shape, one module later;
 *   · a `CHECK` refuses what the file kept quietly, so the write path clamps instead of 500ing.
 */
/* eslint-disable sonarjs/no-floating-point-equality -- exactness is the property under test. */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import type { DeliveryMethod } from '../src/lib/shipping.js';
import {
  countOrdersByStoreSlug,
  countsAsRevenue,
  createOrder,
  getAdminOrdersPage,
  getOrderById,
  getOrdersByBuyer,
  getOrdersBySellerStores,
  getOrdersByStoreSlug,
  getPurchasedCountsByStoreSlug,
  getPurchasedCountsByStoreSlugs,
  getStoreSlugsWithPendingOrders,
  orderBelongsToStore,
  orderStoreNotes,
  purchasedCountsFrom,
  renameStoreSlugInOrders,
  updateOrder,
  type CreateOrderInput,
} from '../src/lib/orders.js';
import {
  CLOSURE_BLOCKING_PAYMENT_STATUSES,
  CLOSURE_BLOCKING_SHIPPING_STATUSES,
} from '../src/lib/order-status-rules.js';

const PAID = '55555555-5555-4555-8555-000000000001';    // 2 stores, 2 lines, notes on both
const PENDING = '55555555-5555-4555-8555-000000000002'; // payment pending, one store
const AGARTAL = '44444444-4444-4444-8444-000000000001';

/**
 * A minimal valid order, in the unit the module speaks.
 *
 * **Its store slug is unique per call, and that is not incidental.** Every test in this file shares
 * one database copy (tests/helpers), so an order created under `keramika` would be counted by the
 * revenue and open-order assertions above it — which is how the first run of this suite failed:
 * three tests disagreeing with the fixture by exactly the orders the tests before them had made.
 * A created order belongs to nobody else's store unless a test says so.
 */
let slugSeq = 0;
function input(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  slugSeq += 1;
  const storeSlug = `ord-test-${slugSeq}`;
  return {
    buyerName: 'קונה', buyerEmail: 'x@example.test', buyerPhone: '050',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{
      productId: AGARTAL, productName: 'א', productSlug: 'a',
      storeSlug, storeName: 'ק', priceAgorot: 1000, qty: 1,
    }],
    storeSubtotals: { [storeSlug]: { storeName: 'ק', subtotalAgorot: 1000, shippingAgorot: 0 } },
    shippingAgorot: 0, totalAgorot: 1000,
    paymentStatus: 'paid',
    ...over,
  };
}

/** The slug `input()` just handed out — for a test that has to name it. */
const lastSlug = () => `ord-test-${slugSeq}`;

describe('reading an order', () => {
  it('rebuilds every field the import wrote, with optional keys ABSENT rather than null', async () => {
    const order = (await getOrderById(PAID))!;
    expect(order.buyerName).toBe('קונה');
    expect(order.buyerAddress).toEqual({ city: 'תל אביב', street: 'רחוב 2', zip: '1234567' });
    expect(order.checkoutRef).toBe('chk-1');
    expect(order.paymentRef).toBe('pay-1');
    // Absent, not null — ~60 call sites are written as `o.trackingNumber ?? ''`.
    expect('trackingNumber' in order).toBe(false);
    expect('buyerId' in order).toBe(false);
    expect(order.items).toHaveLength(2);
    expect(Object.keys(order.storeSubtotals).sort()).toEqual(['keramika', 'tachshitim']);
  });

  it('keeps the LINE ORDER the cart was built in (migration 0004)', async () => {
    // Sorted by `position`, not by the line id — which is a hash of the import sequence, so
    // ordering by it would shuffle the packing list against the confirmation email.
    const order = (await getOrderById(PAID))!;
    expect(order.items.map((i) => i.productName)).toEqual(['אגרטל', 'אגרטל אחר']);
    const again = (await getOrderById(PAID))!;
    expect(again.items.map((i) => i.productName)).toEqual(order.items.map((i) => i.productName));
  });

  it('holds money as EXACT integer agorot, including amounts ILS floats could not represent (§7.7)', async () => {
    const order = (await getOrderById(PAID))!;
    // 271.505 ₪ and a 1.005 ₪ line — the values chosen for the fixture precisely because
    // `1.005 * 2` is 2.0100000000000002 in a float and 201 agorot exactly as an integer.
    expect(order.totalAgorot).toBe(27151);
    expect(order.shippingAgorot).toBe(2000);
    expect(order.items[0]!.priceAgorot).toBe(101);
    expect(order.items[0]!.priceAgorot * order.items[0]!.qty).toBe(202);
    expect(order.storeSubtotals['keramika']!.subtotalAgorot).toBe(201);
  });

  it('splits a discount back into what the seller typed and what it came to', async () => {
    const sub = (await getOrderById(PAID))!.storeSubtotals['keramika']!;
    // `value` is percent-points as typed; `appliedAgorot` is the money. Two columns, two meanings.
    expect(sub.discount).toEqual({ type: 'percent', value: 10, appliedAgorot: 20 });
    expect(sub.deliveryMethod).toBe('delivery');
  });

  it('keeps a snapshot line whose product is no longer a real id', async () => {
    // `productId: "legacy-not-a-uuid"` in the fixture. The column is nullable and unenforced by
    // design (§4): the link is dropped, the snapshot — name, price, qty — is what a receipt is.
    const line = (await getOrderById(PAID))!.items.find((i) => i.storeSlug === 'tachshitim')!;
    expect(line.productId).toBe('');
    expect(line.productName).toBe('אגרטל אחר');
    expect(line.priceAgorot).toBe(25050);
  });

  it('reads per-store notes as a list, coercing the legacy single string', async () => {
    const order = (await getOrderById(PAID))!;
    expect(orderStoreNotes(order, 'keramika')).toEqual(['לארוז במתנה']);
    expect(orderStoreNotes(order, 'tachshitim')).toEqual(['שתי הערות', 'בשורה']);
  });

  it('answers "not found" for a malformed id instead of throwing', async () => {
    // Postgres REJECTS a bad uuid literal rather than failing to match it, so without the shape
    // check a stale link would be a 500 on a page whose honest answer is 404.
    expect(await getOrderById('not-a-uuid')).toBeNull();
    expect(await getOrderById('')).toBeNull();
    expect(await getOrderById(crypto.randomUUID())).toBeNull();
  });
});

describe('finding a store\'s orders', () => {
  it('matches on the items AND on the per-store slice — both halves of orderBelongsToStore', async () => {
    const orders = await getOrdersByStoreSlug('tachshitim');
    expect(orders.map((o) => o.id)).toEqual([PAID]);
    // The predicate the query is written from agrees, on the same row.
    expect(orderBelongsToStore(orders[0]!, 'tachshitim')).toBe(true);
    expect(orderBelongsToStore(orders[0]!, 'nobody')).toBe(false);
  });

  it('returns newest-first, stably, so a dashboard does not reshuffle between loads (§7.13)', async () => {
    const first = (await getOrdersByStoreSlug('keramika')).map((o) => o.id);
    expect(first).toEqual([PENDING, PAID]); // 02-02 before 02-01
    expect((await getOrdersByStoreSlug('keramika')).map((o) => o.id)).toEqual(first);
  });

  it('returns nothing for an empty or unknown slug rather than everything', async () => {
    expect(await getOrdersByStoreSlug('')).toEqual([]);
    expect(await getOrdersBySellerStores([])).toEqual([]);
    expect(await getOrdersByStoreSlug('no-such-store')).toEqual([]);
  });

  it('takes a seller\'s whole set of slugs in ONE query, without double-counting a shared order', async () => {
    const orders = await getOrdersBySellerStores(['keramika', 'tachshitim']);
    expect(orders.map((o) => o.id)).toEqual([PENDING, PAID]);
  });
});

describe('finding a buyer\'s orders', () => {
  it('matches on the email when the order has no account id — a guest who registered later', async () => {
    const orders = await getOrdersByBuyer(undefined, 'buyer@example.test');
    expect(orders.map((o) => o.id)).toEqual([PAID]);
  });

  it('matches on the account id as well, and unions the two', async () => {
    const buyerId = crypto.randomUUID();
    await query(`INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'B', $2, '')`,
      [buyerId, `${buyerId}@example.test`]);
    // Different email, same person: this is exactly the case an email-only match would miss.
    const own = await createOrder(input({ buyerId, buyerEmail: 'other@example.test' }));
    const found = await getOrdersByBuyer(buyerId, 'buyer@example.test');
    expect(found.map((o) => o.id).sort()).toEqual([own.id, PAID].sort());
  });

  it('returns nothing when it knows neither — never the whole platform', async () => {
    expect(await getOrdersByBuyer(undefined, undefined)).toEqual([]);
    expect(await getOrdersByBuyer('not-a-uuid', '')).toEqual([]);
  });
});

describe('units sold', () => {
  it('counts only orders that count as revenue — the SQL rule and the JS rule agree', async () => {
    // The guard that matters: `getPurchasedCountsByStoreSlugs` applies the revenue rule in SQL and
    // `purchasedCountsFrom` applies it in JS. Both read order-status-rules.ts, and this asserts
    // they land on the same number rather than trusting that they will.
    const fromSql = await getPurchasedCountsByStoreSlug('keramika');
    const fromJs = purchasedCountsFrom((await getAdminOrdersPage({}, 1, 10_000)).orders, 'keramika');
    expect(fromSql).toEqual(fromJs);
    // And it is not vacuously equal: the PENDING order's line is excluded by both.
    expect(fromSql[AGARTAL]).toBe(2);
    expect(fromSql['44444444-4444-4444-8444-000000000003']).toBeUndefined();
    expect(countsAsRevenue((await getOrderById(PENDING))!)).toBe(false);
  });

  it('answers for many stores in one query, with an empty bucket for a store that sold nothing', async () => {
    const map = await getPurchasedCountsByStoreSlugs(['keramika', 'tachshitim', 'no-such-store']);
    expect(map.get('keramika')).toEqual({ [AGARTAL]: 2 });
    expect(map.get('no-such-store')).toEqual({});
    expect(await getPurchasedCountsByStoreSlugs([])).toEqual(new Map());
  });
});

describe('the seller\'s alert dot and the closure gate', () => {
  it('names every store holding an order awaiting a first touch, in one query', async () => {
    const pending = await getStoreSlugsWithPendingOrders(['keramika', 'tachshitim', 'no-such-store']);
    expect(pending.has('keramika')).toBe(true);
    expect(pending.has('no-such-store')).toBe(false);
    expect(await getStoreSlugsWithPendingOrders([])).toEqual(new Set());
  });

  it('counts open orders with the statuses the rules table names, not a list of its own', async () => {
    const open = await countOrdersByStoreSlug(
      'keramika', CLOSURE_BLOCKING_PAYMENT_STATUSES, CLOSURE_BLOCKING_SHIPPING_STATUSES,
    );
    expect(open).toBe(2); // paid+pending and pending+pending both block a closure
    expect(await countOrdersByStoreSlug('keramika', [], [])).toBe(0);
  });
});

describe('creating an order', () => {
  it('writes the order, its lines and its per-store slices as one unit', async () => {
    const base = input();
    const slug = lastSlug();
    const created = await createOrder({
      ...base,
      checkoutRef: 'CHK-9',
      items: [
        { productId: AGARTAL, productName: 'ראשון', productSlug: 'a', storeSlug: slug, storeName: 'ק', priceAgorot: 1999, qty: 3 },
        { productId: AGARTAL, productName: 'שני', productSlug: 'b', storeSlug: slug, storeName: 'ק', priceAgorot: 500, qty: 1 },
      ],
      storeSubtotals: {
        [slug]: { storeName: 'ק', subtotalAgorot: 6497, shippingAgorot: 2000, deliveryMethod: 'delivery' as DeliveryMethod },
      },
      shippingAgorot: 2000, totalAgorot: 8497,
    });
    const read = (await getOrderById(created.id))!;
    expect(read.totalAgorot).toBe(8497);
    // 19.99 × 3 is 59.97000000000001 as a float and 5997 agorot as an integer. This is the
    // arithmetic the unit flip existed to make exact.
    expect(read.items[0]!.priceAgorot * read.items[0]!.qty).toBe(5997);
    expect(read.items.map((i) => i.productName)).toEqual(['ראשון', 'שני']);
    expect(read.storeSubtotals[slug]!.shippingAgorot).toBe(2000);
    expect(read.checkoutRef).toBe('CHK-9');
    expect(read.shippingStatus).toBe('pending');
  });

  it('stores per-store notes for a store that has no subtotal row of its own', async () => {
    // `orderBelongsToStore` accepts a store present only in the items, so a seller can hold a
    // claim on a slice with no subtotal — and their note must not fall on the floor.
    const created = await createOrder(input({ sellerNotes: { 'items-only': ['b'] } }));
    const read = (await getOrderById(created.id))!;
    expect(orderStoreNotes(read, 'items-only')).toEqual(['b']);
  });

  it('clamps what a CHECK would refuse instead of turning it into a 500', async () => {
    // The file kept these quietly and `reconcile.ts` reported them; a constraint would make the
    // checkout itself fail. A bad number stays a bad number, on a page that still works.
    const created = await createOrder(input({
      shippingAgorot: -50, totalAgorot: -1,
      items: [{ productId: AGARTAL, productName: 'x', productSlug: 'x', storeSlug: 'clamp-test', storeName: 'ק', priceAgorot: -5, qty: 0 }],
    }));
    const read = (await getOrderById(created.id))!;
    expect(read.totalAgorot).toBe(0);
    expect(read.shippingAgorot).toBe(0);
    expect(read.items[0]!.priceAgorot).toBe(0);
    expect(read.items[0]!.qty).toBe(1);
  });

  it('lets ONE payment ref sit on the several orders of one multi-store checkout (migration 0017)', async () => {
    // The bug this pins is the one that made a two-shop cart un-buyable, and it is a database
    // fact, so only a database test could have caught it: `orders.payment_ref` was declared
    // UNIQUE, while /api/checkout charges ONCE for the whole cart and then writes one order row
    // per store. The second row died on `orders_payment_ref_key`, the transaction rolled back,
    // and the buyer got a 500 — for the exact cart shape a marketplace exists to sell.
    //
    // Deliberately NOT a unique ref per order: the value is the gateway's transaction id, and
    // reconciliation matches our money against theirs through this column. One charge is one ref,
    // on every row it paid for.
    const ref = `PAY-${crypto.randomUUID()}`;
    const first = await createOrder(input({ checkoutRef: 'CHK-MULTI', paymentRef: ref }));
    const second = await createOrder(input({ checkoutRef: 'CHK-MULTI', paymentRef: ref }));
    expect((await getOrderById(first.id))!.paymentRef).toBe(ref);
    expect((await getOrderById(second.id))!.paymentRef).toBe(ref);
    // And one lookup by the ref finds BOTH — what the payment webhook (CURRENT_TASK א.2) will
    // need, and what a unique index could never have returned.
    const { rows } = await query<{ id: string }>('SELECT id FROM orders WHERE payment_ref = $1', [ref]);
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
  });
});

/**
 * The ad click stamped on the order (migration 0010, `lib/attribution.ts`, GO_LIVE §2.5 layer 5).
 * `attribution.test.ts` owns the parsing and the window; what only a database can answer is whether
 * the record survives `jsonb` intact and whether an organic order stays OUT of the partial index —
 * a `JSON.stringify(null)` would write the string `'null'`, which `IS NOT NULL` counts as present
 * and would put every organic order the platform ever takes inside it.
 */
describe('order attribution', () => {
  it('round-trips the click through jsonb, Hebrew campaign included', async () => {
    const attribution = {
      gclid: 'Cj0KCQ-abc', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'קיץ 2026',
      landedAt: '2026-07-20T09:30:00.000Z',
    };
    const created = await createOrder(input({ attribution }));
    expect(created.attribution).toEqual(attribution);
    expect((await getOrderById(created.id))!.attribution).toEqual(attribution);
  });

  it('leaves the column SQL NULL for an organic order, not the JSON null', async () => {
    const created = await createOrder(input());
    expect('attribution' in created).toBe(false);
    const [row] = (await query<{ present: boolean }>(
      'SELECT attribution IS NOT NULL AS present FROM orders WHERE id = $1', [created.id],
    )).rows;
    expect(row!.present).toBe(false);
  });

  it('refuses to write a record that no reader could see', async () => {
    // Cleaned on the way in as well as out: a cookie-shaped object with no timestamp is not an
    // attribution, and storing it would leave the column holding something `toOrder` drops.
    const created = await createOrder(input({
      attribution: { gclid: 'abc' } as unknown as NonNullable<CreateOrderInput['attribution']>,
    }));
    expect('attribution' in created).toBe(false);
  });

  it('keeps a record older than the lookback window — an order is history, not a live claim', async () => {
    // The window decides whether a click may claim a NEW purchase. Applying it on the way out would
    // empty the attribution of every order more than a month old, which is the report itself.
    const attribution = { fbclid: 'IwAR-old', landedAt: '2024-01-01T00:00:00.000Z' };
    const created = await createOrder(input({ attribution }));
    expect((await getOrderById(created.id))!.attribution).toEqual(attribution);
  });
});

describe('updating an order', () => {
  it('touches only the keys the caller sent, and CLEARS one whose value is empty', async () => {
    const created = await createOrder(input({ trackingNumber: 'IL-1' }));
    const patched = (await updateOrder(created.id, { trackingNumber: '' }))!;
    // Built from Object.keys, never from the values — the rule updateStore and updateProduct both
    // needed. A loop that skipped falsy values would make every clear a silent no-op.
    expect('trackingNumber' in patched).toBe(false);
    expect(patched.buyerName).toBe('קונה');
    expect(patched.items).toHaveLength(1);
  });

  it('replaces the lines as a SET, so a deleted one stays deleted', async () => {
    const slug = 'set-replace-test';
    const created = await createOrder(input({
      items: [
        { productId: AGARTAL, productName: 'א', productSlug: 'a', storeSlug: slug, storeName: 'ק', priceAgorot: 100, qty: 1 },
        { productId: AGARTAL, productName: 'ב', productSlug: 'b', storeSlug: slug, storeName: 'ק', priceAgorot: 200, qty: 1 },
      ],
    }));
    const patched = (await updateOrder(created.id, { items: [created.items[0]!] }))!;
    expect(patched.items.map((i) => i.productName)).toEqual(['א']);
  });

  it('does NOT erase the seller notes when only the subtotals are patched', async () => {
    // Both children live in `order_stores`. This is the trap `updateProduct` hit with its two
    // partial variant maps — a write that rebuilds the row from one of them wipes the other, in
    // silence, on an ordinary save. Whichever half the caller did not supply is read back first.
    const created = await createOrder(input({ sellerNotes: { 'notes-keep': ['שמור אותי'] } }));
    const patched = (await updateOrder(created.id, {
      storeSubtotals: { 'notes-keep': { storeName: 'ק', subtotalAgorot: 5000, shippingAgorot: 0 } },
    }))!;
    expect(orderStoreNotes(patched, 'notes-keep')).toEqual(['שמור אותי']);
    expect(patched.storeSubtotals['notes-keep']!.subtotalAgorot).toBe(5000);
  });

  it('does NOT erase the subtotals when only the notes are patched', async () => {
    const base = input();
    const slug = lastSlug();
    const created = await createOrder({ ...base, sellerNotes: { [slug]: ['ישן'] } });
    const patched = (await updateOrder(created.id, { sellerNotes: { [slug]: ['חדש'] } }))!;
    expect(orderStoreNotes(patched, slug)).toEqual(['חדש']);
    expect(patched.storeSubtotals[slug]!.subtotalAgorot).toBe(1000);
  });

  it('rounds a fractional discount percent so the stored value and the applied amount agree', async () => {
    // `discount_percent` is an integer column: 12.5 would land as 12 without a word, leaving the
    // stored percent disagreeing with an `applied` computed from 12.5 — so the seller's next edit
    // of the order would silently produce a different total.
    const created = await createOrder(input({
      storeSubtotals: {
        'pct-test': {
          storeName: 'ק', subtotalAgorot: 1000, shippingAgorot: 0,
          discount: { type: 'percent', value: 12.5, appliedAgorot: 125 },
        },
      },
    }));
    const sub = (await getOrderById(created.id))!.storeSubtotals['pct-test']!;
    expect(Number.isInteger(sub.discount!.value)).toBe(true);
    expect(sub.discount!.appliedAgorot).toBe(125);
  });

  it('answers null for an unknown or malformed id instead of throwing', async () => {
    expect(await updateOrder('not-a-uuid', { trackingNumber: 'x' })).toBeNull();
    expect(await updateOrder(crypto.randomUUID(), { trackingNumber: 'x' })).toBeNull();
  });
});

describe('renaming a store', () => {
  it('repoints the lines AND the per-store slice, so no order is left half-renamed', async () => {
    const created = await createOrder(input({
      items: [{ productId: AGARTAL, productName: 'א', productSlug: 'a', storeSlug: 'renameme', storeName: 'ר', priceAgorot: 100, qty: 1 }],
      storeSubtotals: { renameme: { storeName: 'ר', subtotalAgorot: 100, shippingAgorot: 0 } },
      totalAgorot: 100,
    }));
    await renameStoreSlugInOrders('renameme', 'renamed');
    expect(await getOrdersByStoreSlug('renameme')).toEqual([]);
    const found = (await getOrdersByStoreSlug('renamed')).find((o) => o.id === created.id)!;
    // Both sides moved. One without the other is an order neither slug can fully claim.
    expect(found.items[0]!.storeSlug).toBe('renamed');
    expect(Object.keys(found.storeSubtotals)).toEqual(['renamed']);
  });

  it('is a no-op for a missing or unchanged slug', async () => {
    await expect(renameStoreSlugInOrders('', 'x')).resolves.toBeUndefined();
    await expect(renameStoreSlugInOrders('keramika', 'keramika')).resolves.toBeUndefined();
    expect((await getOrdersByStoreSlug('keramika')).length).toBeGreaterThan(0);
  });
});
