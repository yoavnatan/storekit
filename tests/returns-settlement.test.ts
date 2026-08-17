import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { POST as checkout } from '../src/pages/api/checkout.js';
import { query } from '../src/lib/db.js';
import { getOrderById, updateOrder, countsAsRevenue } from '../src/lib/orders.js';
import { openReturnRequest, moveReturnRequest, hasOpenReturn, getReturnsForOrder } from '../src/lib/return-requests.js';
import { orderHold } from '../src/lib/payout-hold.js';
import { reconcilePlatform } from '../src/lib/reconcile.js';

/**
 * What a REFUND actually costs, asserted against a real database.
 *
 * The standing policy is that anything moving money or stock ships with a test in the same change,
 * and a return does both — through `settleStatusChange`, which this module deliberately does not
 * re-implement. So the thing worth asserting is not the arithmetic (that is `refund-owed.ts`, already
 * covered) but the JOIN: that driving a request to `refunded` really does put the units back, really
 * does take the order out of revenue, and really does leave a refund debt behind for the admin's
 * cross-check to find.
 *
 * The last one is the point. `refund_settled` is written by nothing until a payment provider exists,
 * so a returned order must show up as money still owed — and a test that only checked the status
 * would pass on a version that silently closed the obligation.
 */

const ctx = (body: unknown): APIContext => ({
  request: new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies: { get: () => undefined, set: () => {}, delete: () => {}, has: () => false } as unknown as AstroCookies,
  clientAddress: '127.0.0.1',
} as unknown as APIContext);

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const STORE = { slug: 'keramika', name: 'קרמיקה', sellerId: '11111111-1111-4111-8111-000000000001' };

const stockOf = async (): Promise<number> => {
  const { rows } = await query<{ stock: number }>(
    `SELECT stock FROM store_products WHERE store_id = $1 AND slug = 'agartal'`, [KERAMIKA]);
  return Number(rows[0]?.stock ?? -1);
};

/** One paid, delivered order for one store — the only shape a return can start from. */
async function deliveredOrder() {
  const res = await checkout(ctx({
    buyerName: 'דנה', buyerEmail: 'returns@example.test', buyerPhone: '0501234567',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ storeSlug: 'keramika', productSlug: 'agartal', qty: 1, selectedVariants: { צבע: 'כחול' } }],
    idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
  }));
  const body = await res.json() as { orderIds?: string[] };
  const id = body.orderIds![0]!;
  await updateOrder(id, { shippingStatus: 'delivered', deliveredAt: new Date().toISOString() });
  return (await getOrderById(id))!;
}

beforeEach(async () => {
  await query(`UPDATE store_products SET stock = 7 WHERE store_id = $1 AND slug = 'agartal'`, [KERAMIKA]);
  await query(`DELETE FROM seller_ledger_adjustments`);
  await query(`DELETE FROM return_requests`);
  await query(`DELETE FROM money_events`);
  await query(`DELETE FROM checkout_idempotency`);
  await query(`DELETE FROM order_items`);
  await query(`DELETE FROM order_stores`);
  await query(`DELETE FROM orders`);
});

describe('a refunded return settles the order, the stock and the debt', () => {
  it('puts the units back, drops the order out of revenue, and leaves the money owed', async () => {
    const order = await deliveredOrder();
    const afterSale = await stockOf();
    expect(countsAsRevenue(order)).toBe(true);

    const opened = await openReturnRequest({ order, storeSlug: 'keramika', reason: 'damaged' });
    expect('error' in opened).toBe(false);
    const req = opened as Exclude<typeof opened, { error: string }>;
    // Inside the statutory window the seller has no say — it is approved on arrival.
    expect(req.status).toBe('approved');
    // Faulty goods: the original delivery charge comes back too.
    expect(req.refundAgorot).toBe(order.totalAgorot);

    await moveReturnRequest({ id: req.id, to: 'in_transit', actor: 'buyer', store: STORE });
    await moveReturnRequest({ id: req.id, to: 'received', actor: STORE.sellerId, store: STORE });
    const done = await moveReturnRequest({ id: req.id, to: 'refunded', actor: STORE.sellerId, store: STORE });
    expect('error' in done).toBe(false);

    // ── The order ──
    const settled = (await getOrderById(order.id))!;
    expect(settled.shippingStatus).toBe('returned');
    // NOT 'cancelled': the sale really happened, and the two must stay distinguishable forever.
    expect(settled.shippingStatus).not.toBe('cancelled');
    expect(countsAsRevenue(settled)).toBe(false);

    // ── The stock ──
    expect(await stockOf()).toBe(afterSale + 1);

    // ── The money ──
    // A debt, not a transfer: nothing writes `refund_settled` until a provider can actually refund,
    // so the admin's cross-check has to still be reporting this as outstanding.
    const report = await reconcilePlatform(['keramika']);
    const owed = report.discrepancies.filter((d) => d.check.includes('זיכוי'));
    expect(owed).toHaveLength(1);
    expect(owed[0]!.actualAgorot).toBe(order.totalAgorot);
  });

  it('refunds the goods but not the delivery charge when the buyer simply changed their mind', async () => {
    const order = await deliveredOrder();
    const opened = await openReturnRequest({ order, storeSlug: 'keramika', reason: 'changed_mind' });
    const req = opened as Exclude<typeof opened, { error: string }>;
    expect(req.refundAgorot).toBe(order.totalAgorot - order.shippingAgorot);
    expect(req.returnShippingPayer).toBe('buyer');
  });

  it('freezes the payout while a request is open, and releases it when the request closes', async () => {
    const order = await deliveredOrder();
    const opened = await openReturnRequest({ order, storeSlug: 'keramika', reason: 'changed_mind' });
    const req = opened as Exclude<typeof opened, { error: string }>;

    expect(await hasOpenReturn(order.id)).toBe(true);
    // The hold rule reads the flag its caller passes; the SQL twin asks the same question of the
    // same table (RELEASABLE_SQL), and tests/payout-hold.test.ts covers the arithmetic either way.
    expect(orderHold({ ...order, hasOpenReturn: true }).state).toBe('held');
    expect(orderHold({ ...order, hasOpenReturn: true }).basis).toBe('return_open');

    // Closing it — here by the seller refusing — puts the order back on the ordinary clock.
    await moveReturnRequest({ id: req.id, to: 'rejected', actor: STORE.sellerId, store: STORE });
    expect(await hasOpenReturn(order.id)).toBe(false);
    expect(orderHold({ ...order, hasOpenReturn: false }).basis).not.toBe('return_open');
  });

  it('a PARTIAL return pays by adjustment and leaves the order delivered', async () => {
    const order = await deliveredOrder();
    const before = await stockOf();
    const opened = await openReturnRequest({
      order, storeSlug: 'keramika', reason: 'damaged',
      returnedLines: [{ position: 0, qty: 1 }],
    });
    const req = opened as Exclude<typeof opened, { error: string }>;
    expect(req.returnedLines).toEqual([{ position: 0, qty: 1 }]);
    // The delivery charge never comes back on a partial return, even on a faulty item: the van came
    // for what the buyer kept.
    expect(req.refundAgorot).toBe(order.items[0]!.priceAgorot);

    await moveReturnRequest({ id: req.id, to: 'in_transit', actor: 'buyer', store: STORE });
    await moveReturnRequest({ id: req.id, to: 'received', actor: STORE.sellerId, store: STORE });
    await moveReturnRequest({ id: req.id, to: 'refunded', actor: STORE.sellerId, store: STORE });

    // The order is untouched — it really was delivered, and most of it stayed delivered. This is the
    // whole decision: a status is a statement about the WHOLE order.
    const settled = (await getOrderById(order.id))!;
    expect(settled.shippingStatus).toBe('delivered');
    expect(countsAsRevenue(settled)).toBe(true);

    // The units came back.
    expect(await stockOf()).toBe(before + 1);

    // The money moved in its own row rather than by rewriting the order.
    const { rows: adj } = await query<{ amount_agorot: string }>(
      `SELECT amount_agorot FROM seller_ledger_adjustments WHERE order_id = $1`, [order.id]);
    expect(adj).toHaveLength(1);
    expect(Number(adj[0]!.amount_agorot)).toBeLessThan(0);

    const { rows: due } = await query<{ amount_agorot: string }>(
      `SELECT amount_agorot FROM money_events WHERE order_id = $1 AND type = 'refund_due'`, [order.id]);
    expect(due).toHaveLength(1);
    expect(Number(due[0]!.amount_agorot)).toBe(req.refundAgorot);
  });

  it('debits the seller for EVERY partial return, not just the first', async () => {
    // The bug this pins, found in review before it shipped: `seller_ledger_adjustments` was unique on
    // (order_id, kind), which is correct for a cancellation — one event, one debit, however many
    // times a webhook fires — and wrong the moment one order can be returned twice. The second
    // clawback hit ON CONFLICT DO NOTHING and vanished, so the buyer was refunded for both items and
    // the seller was debited for one. The difference came out of the platform, silently.
    const order = await deliveredOrder();

    const first = await openReturnRequest({
      order, storeSlug: 'keramika', reason: 'damaged', returnedLines: [{ position: 0, qty: 1 }],
    }) as { id: string };
    await moveReturnRequest({ id: first.id, to: 'in_transit', actor: 'buyer', store: STORE });
    await moveReturnRequest({ id: first.id, to: 'received', actor: STORE.sellerId, store: STORE });
    await moveReturnRequest({ id: first.id, to: 'refunded', actor: STORE.sellerId, store: STORE });

    // The first request is closed, so the partial unique index lets a second one open on the same
    // order — which is the real-world case: the lamp this week, the shade next month.
    const second = await openReturnRequest({
      order, storeSlug: 'keramika', reason: 'damaged', returnedLines: [{ position: 0, qty: 1 }],
    }) as { id: string };
    await moveReturnRequest({ id: second.id, to: 'in_transit', actor: 'buyer', store: STORE });
    await moveReturnRequest({ id: second.id, to: 'received', actor: STORE.sellerId, store: STORE });
    await moveReturnRequest({ id: second.id, to: 'refunded', actor: STORE.sellerId, store: STORE });

    const { rows } = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM seller_ledger_adjustments WHERE order_id = $1`, [order.id]);
    expect(rows[0]!.n, 'both partial returns must debit the seller').toBe(2);
  });

  it('refuses a second open request on one order', async () => {
    const order = await deliveredOrder();
    await openReturnRequest({ order, storeSlug: 'keramika', reason: 'damaged' });
    const second = await openReturnRequest({ order, storeSlug: 'keramika', reason: 'wrong_item' });
    expect('error' in second).toBe(true);
    expect((await getReturnsForOrder(order.id))).toHaveLength(1);
  });

  it('leaves a terminal order alone, and does not restock it a second time', async () => {
    // A regression pin, and honestly labelled as one: this passes with the `canTransition` guard in
    // `moveReturnRequest` removed, because `settleStatusChange` already tests the BEFORE status for
    // both the restock and the refund obligation. What the guard adds is refusing to move a terminal
    // order at all — no bogus journal row, no status rewritten out from under whatever made it
    // terminal, no second notification to the buyer.
    //
    // It is here because the stock half is the expensive half to be wrong about, and a future edit
    // to either module is exactly what would make it reachable.
    const order = await deliveredOrder();
    const opened = await openReturnRequest({ order, storeSlug: 'keramika', reason: 'damaged' });
    const req = opened as Exclude<typeof opened, { error: string }>;
    await moveReturnRequest({ id: req.id, to: 'in_transit', actor: 'buyer', store: STORE });
    await moveReturnRequest({ id: req.id, to: 'received', actor: STORE.sellerId, store: STORE });

    // Straight to a DIFFERENT terminal status behind the request's back. `cancelled` and not
    // `returned`: an identical status short-circuits inside `settleStatusChange` before it decides
    // anything, so a test that used the same word would pass with or without the guard — which is
    // exactly what the first version of this test did.
    await updateOrder(order.id, { shippingStatus: 'cancelled' });
    const restockedOnce = await stockOf();

    await moveReturnRequest({ id: req.id, to: 'refunded', actor: STORE.sellerId, store: STORE });
    expect(await stockOf()).toBe(restockedOnce);
  });
});
