/**
 * A real POST to /api/checkout, against a real Postgres, with a cart spanning two stores.
 *
 * **This file exists because of what its absence cost on 2026-08-07.** `orders.payment_ref` was
 * declared UNIQUE while the checkout charges once per cart and writes one order row per store, so
 * EVERY multi-store purchase died on the second INSERT and returned a 500. It was live for as long
 * as the schema has existed, and the owner found it by trying to buy something — not from a test —
 * because nothing in a 2,800-test suite ever ran this endpoint against a real database:
 * `checkout.test.ts` mocks `createOrder` and the entire `orders` module, so it validates the
 * endpoint's DECISIONS while the database it decides against is imaginary. A constraint cannot fail
 * in a test that never reaches a constraint.
 *
 * So: nothing here is mocked except the clock the payment provider does not have. Real stores, real
 * products, real stock decrements, real order rows, real idempotency ledger, real money journal.
 * The one thing that is deliberately NOT stubbed is the shape of the failure — if a future schema
 * change makes a two-store cart impossible again, the first assertion in this file goes red.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { POST } from '../src/pages/api/checkout.js';
import { query } from '../src/lib/db.js';
import { countsAsRevenue, getOrderById, updateOrder, type Order } from '../src/lib/orders.js';
import { checkoutGroupKey } from '../src/lib/checkout-group.js';
import { MOCK_DECLINE_MARKER } from '../src/lib/payment.js';
import { reconcilePlatform, type Discrepancy } from '../src/lib/reconcile.js';
import { recordMoneyEvent } from '../src/lib/money-events.js';
import { createsRefundObligation, recordRefundOwed } from '../src/lib/refund-owed.js';

/** Enough of AstroCookies for the handler, which reads a seller session and the attribution cookie. */
const noCookies = { get: () => undefined } as unknown as AstroCookies;

const ctx = (body: unknown): APIContext => ({
  request: new Request('https://example.test/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies: noCookies,
} as unknown as APIContext);

/** A fresh 16+ char key per attempt — the ledger keys on it, so reusing one replays. */
const newKey = () => crypto.randomUUID().replace(/-/g, '');

/** The two-store cart. Both stores hold a product slugged `agartal` in the fixture, which is what
 *  makes this the exact shape the bug needed: one checkout, two stores, two order rows. */
const twoStoreCart = (over: Record<string, unknown> = {}) => ({
  buyerName: 'קונה בדיקה',
  buyerEmail: 'e2e@example.test',
  buyerPhone: '0501234567',
  buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
  items: [
    { storeSlug: 'keramika', productSlug: 'agartal', qty: 1 },
    { storeSlug: 'tachshitim', productSlug: 'agartal', qty: 1 },
  ],
  idempotencyKey: newKey(),
  ...over,
});

async function stockOf(storeId: string): Promise<number> {
  const { rows } = await query<{ stock: number }>(
    `SELECT stock FROM store_products WHERE store_id = $1 AND slug = 'agartal'`, [storeId],
  );
  return Number(rows[0]?.stock ?? -1);
}
const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const TACHSHITIM = '22222222-2222-4222-8222-000000000002';

beforeEach(async () => {
  // Each test starts from a known cart-worth of stock and an empty journal, so a count assertion
  // means what it says.
  await query(`UPDATE store_products SET stock = 7 WHERE store_id = $1 AND slug = 'agartal'`, [KERAMIKA]);
  await query(`UPDATE store_products SET stock = 5 WHERE store_id = $1 AND slug = 'agartal'`, [TACHSHITIM]);
  await query(`DELETE FROM money_events`);
  await query(`DELETE FROM checkout_idempotency`);
  // Orders too, children first (order_items has ON DELETE RESTRICT by design — a sold line may
  // not be erased by deleting its order). Without this each test counts the previous ones' rows.
  await query(`DELETE FROM order_items`);
  await query(`DELETE FROM order_stores`);
  await query(`DELETE FROM orders`);
});

describe('a cart spanning two stores can actually be bought', () => {
  it('returns 201 and writes one order per store under ONE checkout', async () => {
    const res = await POST(ctx(twoStoreCart()));
    // The assertion the missing test would have made. Under the UNIQUE constraint this was a 500.
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await res.json() as { orderIds: string[]; checkoutRef: string };
    expect(body.orderIds).toHaveLength(2);

    const orders = await Promise.all(body.orderIds.map((id) => getOrderById(id)));
    // One charge, so ONE payment reference across both rows — the fact the constraint denied.
    const refs = new Set(orders.map((o) => o!.paymentRef));
    expect(refs.size).toBe(1);
    // And both rows group into a single purchase for the admin and the buyer.
    expect(new Set(orders.map((o) => checkoutGroupKey(o!))).size).toBe(1);
    expect(orders.every((o) => o!.checkoutRef === body.checkoutRef)).toBe(true);
    // The stores are the two we asked for, one slice each.
    expect(orders.flatMap((o) => o!.items.map((i) => i.storeSlug)).sort()).toEqual(['keramika', 'tachshitim']);
  });

  it('takes the stock of BOTH stores, not just the first', async () => {
    await POST(ctx(twoStoreCart()));
    expect(await stockOf(KERAMIKA)).toBe(6);
    expect(await stockOf(TACHSHITIM)).toBe(4);
  });

  it('marks the orders paid only after the capture, and journals both steps', async () => {
    const res = await POST(ctx(twoStoreCart()));
    const { orderIds } = await res.json() as { orderIds: string[] };
    const orders = await Promise.all(orderIds.map((id) => getOrderById(id)));
    expect(orders.every((o) => o!.paymentStatus === 'paid')).toBe(true);

    const { rows } = await query<{ type: string; to_value: string | null }>(
      `SELECT type, to_value FROM money_events ORDER BY at, id`,
    );
    const types = rows.map((r) => r.type);
    // The ORDER is the property: authorize, then the order rows, then the capture that flips them
    // to paid. An 'order_created' that reads 'paid' before any capture is the old flow's lie.
    expect(types[0]).toBe('payment_attempted');
    expect(types.filter((t) => t === 'order_created')).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'order_created').every((r) => r.to_value === 'pending')).toBe(true);
    expect(types[types.length - 1]).toBe('payment_status_changed');
    expect(rows[rows.length - 1]!.to_value).toBe('paid');
  });
});

describe('a declined card leaves nothing behind', () => {
  it('creates no order, takes no stock, and answers 402', async () => {
    const before = { k: await stockOf(KERAMIKA), t: await stockOf(TACHSHITIM) };
    const res = await POST(ctx(twoStoreCart({ buyerEmail: `nope${MOCK_DECLINE_MARKER}example.test` })));
    expect(res.status).toBe(402);
    expect(await stockOf(KERAMIKA)).toBe(before.k);
    expect(await stockOf(TACHSHITIM)).toBe(before.t);
    const { rows } = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM orders WHERE buyer_email = 'e2e@example.test'`);
    expect(Number(rows[0]!.n)).toBe(0);
    // The decline is still journalled — it is the event that leaves no order row to prove it
    // happened, which is exactly why it is recorded.
    const events = await query<{ type: string }>(`SELECT type FROM money_events`);
    expect(events.rows.map((r) => r.type)).toContain('payment_attempted');
  });
});

describe('the same key twice is one purchase', () => {
  it('replays the first result instead of buying again', async () => {
    const cart = twoStoreCart();
    const first = await POST(ctx(cart));
    const firstBody = await first.json() as { orderIds: string[] };
    const stockAfterFirst = await stockOf(KERAMIKA);

    const second = await POST(ctx(cart));
    const secondBody = await second.json() as { orderIds: string[] };
    // Same orders handed back, and — the point — the stock did not move a second time.
    expect(secondBody.orderIds.sort()).toEqual(firstBody.orderIds.sort());
    expect(await stockOf(KERAMIKA)).toBe(stockAfterFirst);
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM orders WHERE checkout_ref IS NOT NULL AND buyer_email = 'e2e@example.test'`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

/**
 * ── The audit (owner, 2026-08-07, review-diff row 2): where the money and what a seller or buyer
 *    SEES can disagree ──
 *
 * The tests above prove a purchase works. These start from the opposite end: they put the data into
 * each state where the two could part company, and require the reconciliation to SAY SO. That is
 * the difference between a bug fixed and a class closed — none of these depends on anyone having
 * imagined the particular way it happened, only on the state being reachable.
 */
describe('every way the money and the screens can disagree is reported', () => {
  /** The reconciliation as the admin dashboard runs it: over the real platform, all stores. */
  async function findings(): Promise<Discrepancy[]> {
    const { rows: storeRows } = await query<{ slug: string }>('SELECT slug FROM stores');
    return (await reconcilePlatform(storeRows.map((s) => s.slug))).discrepancies;
  }
  const checks = async () => (await findings()).map((d) => d.check);

  async function buyTwoStores(): Promise<Order[]> {
    const res = await POST(ctx(twoStoreCart()));
    const { orderIds } = await res.json() as { orderIds: string[] };
    return Promise.all(orderIds.map(async (id) => (await getOrderById(id))!));
  }

  it('a healthy purchase reports nothing at all', async () => {
    // The floor under every assertion below: if this is not clean, "it reported something" proves
    // nothing about the state the next test creates.
    await buyTwoStores();
    expect(await findings()).toEqual([]);
  });

  describe('a paid order that is cancelled owes the buyer money', () => {
    it('records the obligation in the journal, separately from the status move', async () => {
      // The status row says the order stopped counting. It says nothing about the money, which was
      // really captured off a real card — that is what `refund_due` is for, and it did not exist.
      const [first] = await buyTwoStores();
      const before = { paymentStatus: first!.paymentStatus, shippingStatus: first!.shippingStatus };
      const after = (await updateOrder(first!.id, { shippingStatus: 'cancelled' }))!;
      const owed = await recordRefundOwed(before, after, after.items[0]!.storeSlug, 'seller-x');
      expect(owed).toBe(first!.totalAgorot);

      const { rows } = await query<{ amount_agorot: string | number }>(
        `SELECT amount_agorot FROM money_events WHERE type = 'refund_due' AND order_id = $1`, [first!.id],
      );
      expect(rows).toHaveLength(1);
      // The whole slice, goods AND shipping — that is what left the buyer's card, not the seller's
      // net share of it.
      expect(Number(rows[0]!.amount_agorot)).toBe(first!.totalAgorot);
    });

    it('is reported as outstanding until a settlement pairs it off', async () => {
      const [first] = await buyTwoStores();
      const before = { paymentStatus: first!.paymentStatus, shippingStatus: first!.shippingStatus };
      const after = (await updateOrder(first!.id, { shippingStatus: 'cancelled' }))!;
      await recordRefundOwed(before, after, after.items[0]!.storeSlug, 'seller-x');

      const owed = (await findings()).filter((d) => d.check.includes('זיכוי'));
      expect(owed).toHaveLength(1);
      expect(owed[0]!.actual).toBe(first!.totalAgorot);
      expect(owed[0]!.severity).toBe('error');

      // Nothing writes `refund_settled` yet — it needs the payment provider's refund call, and no
      // provider is chosen (GO_LIVE §3). Written by hand here so the CHECK is proved to close,
      // rather than being a report that can only ever grow.
      await recordMoneyEvent({ type: 'refund_settled', orderId: first!.id, amountAgorot: first!.totalAgorot, actor: 'admin' });
      expect((await findings()).filter((d) => d.check.includes('זיכוי'))).toEqual([]);
    });

    it('owes nothing when the order was never paid for', async () => {
      // A capture that failed cancels the rows too — and there the buyer's card was never charged,
      // so an obligation would be an invention. The rule asks the status table, not the word
      // "cancelled" (refund-owed.ts).
      const [first] = await buyTwoStores();
      const before = { paymentStatus: 'pending' as const, shippingStatus: first!.shippingStatus };
      const after = (await updateOrder(first!.id, { paymentStatus: 'failed', shippingStatus: 'cancelled' }))!;
      expect(createsRefundObligation(before, after)).toBe(false);
      expect(await recordRefundOwed(before, after, 'keramika', 'system')).toBe(0);
      expect((await findings()).filter((d) => d.check.includes('זיכוי'))).toEqual([]);
    });
  });

  describe("an order stuck 'pending' because the capture never finished", () => {
    it('is reported, with the amount and how long it has been stuck', async () => {
      // The window between the order write and the capture (payment.ts). A process that dies there
      // leaves stock off the shelf, a seller with nothing to ship, a buyer who was told nothing —
      // and possibly a real charge. Nothing looked for these before.
      const [first] = await buyTwoStores();
      await query(
        `UPDATE orders SET payment_status = 'pending', created_at = now() - interval '2 hours' WHERE id = $1`,
        [first!.id],
      );
      const stuckFindings = (await findings()).filter((d) => d.check.includes('תקועה'));
      expect(stuckFindings).toHaveLength(1);
      expect(stuckFindings[0]!.actual).toBe(first!.totalAgorot);
      expect(stuckFindings[0]!.severity).toBe('error');
    });

    it('does not report a checkout that is merely in flight', async () => {
      // A pending row written seconds ago is a purchase happening right now. Reporting it would
      // make the card cry wolf on every live checkout.
      const [first] = await buyTwoStores();
      await query(`UPDATE orders SET payment_status = 'pending' WHERE id = $1`, [first!.id]);
      expect((await findings()).filter((d) => d.check.includes('תקועה'))).toEqual([]);
    });
  });

  describe('a charge in the journal with no order behind it', () => {
    it('is reported — the exact shape migration 0017 was written for', async () => {
      // An authorization whose checkout produced no order row and was never voided. Before 0017 the
      // UNIQUE on payment_ref made every multi-store cart end here.
      await recordMoneyEvent({
        type: 'payment_attempted', checkoutRef: 'ORPHAN01', amountAgorot: 12345,
        actor: 'buyer', detail: 'authorized ref=mock_orphan',
      });
      await query(`UPDATE money_events SET at = now() - interval '2 hours' WHERE checkout_ref = 'ORPHAN01'`);
      const orphaned = (await findings()).filter((d) => d.check.includes('בלי הזמנה'));
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0]!.actual).toBe(12345);
    });

    it('is NOT reported once the hold was released', async () => {
      // `charge_voided` is the record that the money went back. With it, there is nothing owed and
      // nothing to chase.
      await recordMoneyEvent({
        type: 'payment_attempted', checkoutRef: 'ORPHAN02', amountAgorot: 500,
        actor: 'buyer', detail: 'authorized ref=mock_orphan2',
      });
      await recordMoneyEvent({ type: 'charge_voided', checkoutRef: 'ORPHAN02', amountAgorot: 500, actor: 'system' });
      await query(`UPDATE money_events SET at = now() - interval '2 hours' WHERE checkout_ref = 'ORPHAN02'`);
      expect((await findings()).filter((d) => d.check.includes('בלי הזמנה'))).toEqual([]);
    });

    it('is NOT reported for a decline, which took nothing', async () => {
      await recordMoneyEvent({
        type: 'payment_attempted', checkoutRef: 'DECLINE1', amountAgorot: 900,
        actor: 'buyer', detail: 'declined: insufficient funds',
      });
      await query(`UPDATE money_events SET at = now() - interval '2 hours' WHERE checkout_ref = 'DECLINE1'`);
      expect((await findings()).filter((d) => d.check.includes('בלי הזמנה'))).toEqual([]);
    });
  });

  describe('a multi-store purchase with one slice cancelled', () => {
    it('leaves the surviving slice counting and the cancelled one owed back', async () => {
      // What each side sees: the seller of the live store still has an order to ship and revenue;
      // the seller of the cancelled one has neither; the buyer's purchase is still a purchase, with
      // one slice cancelled inside it. The money that must NOT quietly stay with us is the cancelled
      // slice's — and the reconciliation names exactly that amount.
      const [cancelledSlice, liveSlice] = await buyTwoStores();
      const before = { paymentStatus: cancelledSlice!.paymentStatus, shippingStatus: cancelledSlice!.shippingStatus };
      const after = (await updateOrder(cancelledSlice!.id, { shippingStatus: 'cancelled' }))!;
      await recordRefundOwed(before, after, after.items[0]!.storeSlug, 'seller-x');

      // The live slice is untouched by its neighbour's cancellation — one order per store is what
      // makes that true, and it is the property the whole split exists for.
      const stillLive = (await getOrderById(liveSlice!.id))!;
      expect(stillLive.shippingStatus).not.toBe('cancelled');
      expect(countsAsRevenue(stillLive)).toBe(true);
      expect(countsAsRevenue((await getOrderById(cancelledSlice!.id))!)).toBe(false);

      const owed = (await findings()).filter((d) => d.check.includes('זיכוי'));
      expect(owed).toHaveLength(1);
      expect(owed[0]!.actual).toBe(cancelledSlice!.totalAgorot);
      // …and specifically NOT the whole purchase. Refunding a buyer for a parcel that is on its way
      // is the mirror-image failure, and it is the one nobody would notice.
      expect(owed[0]!.actual).toBeLessThan(cancelledSlice!.totalAgorot + liveSlice!.totalAgorot);
    });
  });

  it('reports every one of them at once rather than stopping at the first', async () => {
    // A dashboard card that shows one problem while three exist is worse than one that shows none,
    // because it reads as "and that is all of them".
    const [first, second] = await buyTwoStores();
    const before = { paymentStatus: first!.paymentStatus, shippingStatus: first!.shippingStatus };
    await recordRefundOwed(before, (await updateOrder(first!.id, { shippingStatus: 'cancelled' }))!, 'keramika', 'seller-x');
    await query(
      `UPDATE orders SET payment_status = 'pending', created_at = now() - interval '2 hours' WHERE id = $1`,
      [second!.id],
    );
    await recordMoneyEvent({
      type: 'payment_attempted', checkoutRef: 'ORPHAN03', amountAgorot: 700,
      actor: 'buyer', detail: 'authorized ref=mock_orphan3',
    });
    await query(`UPDATE money_events SET at = now() - interval '2 hours' WHERE checkout_ref = 'ORPHAN03'`);

    const found = await checks();
    expect(found.some((c) => c.includes('זיכוי'))).toBe(true);
    expect(found.some((c) => c.includes('תקועה'))).toBe(true);
    expect(found.some((c) => c.includes('בלי הזמנה'))).toBe(true);
  });
});
