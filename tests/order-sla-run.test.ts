/**
 * The job that gives a buyer their money back — and the four ways it could get that wrong.
 *
 *   1. Cancelling an order the seller DID handle. The deadline sits on the seller's own milestone
 *      ('shipped' for a courier order, 'ready' for self-pickup), never on a courier's, and a seller
 *      who met it must never be punished for someone else's delay.
 *   2. Cancelling and keeping the money. A cancellation that restocks but writes no `refund_due` is
 *      a product back on the shelf and a buyer's payment still with us, with no screen saying so.
 *   3. Cancelling twice. A retried job, two app servers, a person re-triggering it.
 *   4. Nagging. A warning that repeats every day is a notification bell people stop looking at.
 *
 * Real rows throughout, because every one of those is a claim about what the DATABASE holds after
 * the run — not about what a function returned.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { query, rows } from '../src/lib/db.js';
import { runOrderSla, getSlaCandidates } from '../src/lib/order-sla-run.js';
import { SHIP_WARNING_DAYS, SHIP_AUTO_CANCEL_DAYS } from '../src/lib/payout-schedule.js';
import { addDaysISO } from '../src/lib/date-range.js';
import type { Order } from '../src/lib/orders.js';
import type { DeliveryMethod } from '../src/lib/shipping.js';

const TODAY = '2026-08-10';
const SELLER_ID = '11111111-1111-4111-8111-0000000000a1';
const STORE_ID = '22222222-2222-4222-8222-0000000000a1';
const SLUG = 'sla-shop';
const PRODUCT_ID = '33333333-3333-4333-8333-0000000000a1';

const at = (dayISO: string) => `${dayISO}T09:00:00.000Z`;
const daysAgo = (n: number) => addDaysISO(TODAY, -n);

interface OrderSpec {
  paidDaysAgo: number;
  shippingStatus?: Order['shippingStatus'];
  paymentStatus?: Order['paymentStatus'];
  deliveryMethod?: DeliveryMethod;
  qty?: number;
}

/** One order, as the two-and-a-bit tables every caller actually reads it from. */
async function seedOrder(spec: OrderSpec): Promise<string> {
  const id = crypto.randomUUID();
  const paidAt = at(daysAgo(spec.paidDaysAgo));
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, total_agorot, payment_status, shipping_status, paid_at, created_at)
     VALUES ($1, 'Buyer', 'buyer@example.com', 12000, $2, $3, $4::timestamptz, $4::timestamptz)`,
    [id, spec.paymentStatus ?? 'paid', spec.shippingStatus ?? 'pending', paidAt],
  );
  await query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot, delivery_method)
     VALUES ($1, $2, 'SLA Shop', 10000, 2000, $3)`,
    [id, SLUG, spec.deliveryMethod ?? null],
  );
  await query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_slug, store_slug, store_name, price_agorot, qty)
     VALUES ($1, $2, $3, 'Thing', 'thing', $4, 'SLA Shop', 10000, $5)`,
    [crypto.randomUUID(), id, PRODUCT_ID, SLUG, spec.qty ?? 1],
  );
  return id;
}

const statusOf = async (id: string): Promise<string> =>
  (await rows<{ shipping_status: string }>('SELECT shipping_status FROM orders WHERE id = $1', [id]))[0]!.shipping_status;

const stock = async (): Promise<number> =>
  (await rows<{ stock: number }>('SELECT stock FROM store_products WHERE id = $1', [PRODUCT_ID]))[0]!.stock;

const moneyEventsFor = async (orderId: string): Promise<string[]> =>
  (await rows<{ type: string }>('SELECT type FROM money_events WHERE order_id = $1 ORDER BY type', [orderId]))
    .map((r) => r.type);

const notificationsFor = async (): Promise<{ title: string; related_id: string | null }[]> =>
  rows<{ title: string; related_id: string | null }>(
    'SELECT title, related_id FROM notifications WHERE user_id = $1 ORDER BY created_at', [SELLER_ID]);

beforeEach(async () => {
  await query('DELETE FROM money_events');
  await query('DELETE FROM notifications');
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  await query('DELETE FROM store_products WHERE id = $1', [PRODUCT_ID]);
  await query('DELETE FROM stores WHERE id = $1', [STORE_ID]);
  await query('DELETE FROM sellers WHERE id = $1', [SELLER_ID]);
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, created_at)
     VALUES ($1, 'SLA Seller', $2, '', now())`,
    [SELLER_ID, `sla-${SELLER_ID}@example.com`],
  );
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, tagline, description, colors, created_at)
     VALUES ($1, $2, $3, 'SLA Shop', '', '', '{"primary":"#000","accent":"#111"}'::jsonb, now())`,
    [STORE_ID, SELLER_ID, SLUG],
  );
  await query(
    `INSERT INTO store_products (id, store_id, slug, name, price_agorot, stock)
     VALUES ($1, $2, 'thing', 'Thing', 10000, 5)`,
    [PRODUCT_ID, STORE_ID],
  );
});

describe('an order the seller never sent', () => {
  it('is cancelled, restocked, and recorded as money owed back to the buyer', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 2, qty: 2 });

    const result = await runOrderSla(TODAY);

    expect(result.cancelled).toBe(1);
    expect(await statusOf(id)).toBe('cancelled');
    // The whole slice, goods and shipping alike — that is what left the buyer's card
    // (refund-owed.ts#refundOwedAgorot), not the seller's net share.
    expect(result.refundOwedAgorot).toBe(12000);
    // Both halves, and the second is the one this job exists for: a `shipping_status_changed` row
    // alone is a fulfilment fact that says nothing about the money.
    expect(await moneyEventsFor(id)).toEqual(['refund_due', 'shipping_status_changed']);
    // Units back on the shelf — the same restock a seller's own cancellation performs, because it
    // is literally the same code path (order-status-change.ts).
    expect(await stock()).toBe(7);
  });

  it('tells the seller, so an order does not just vanish from their dashboard', async () => {
    await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 2 });
    await runOrderSla(TODAY);
    expect((await notificationsFor()).map((n) => n.title)).toContain('הזמנה בוטלה אוטומטית');
  });

  it('cannot be cancelled twice, however many times the job runs', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 2, qty: 2 });

    await runOrderSla(TODAY);
    const second = await runOrderSla(TODAY);

    // Not "refused" — not even a candidate. A cancelled order fails the revenue status list, which
    // is what makes the idempotency a property of the status table rather than of control flow.
    expect(second.scanned).toBe(0);
    expect(second.cancelled).toBe(0);
    expect(await statusOf(id)).toBe('cancelled');
    expect(await stock()).toBe(7);
    expect((await moneyEventsFor(id)).filter((t) => t === 'refund_due')).toHaveLength(1);
  });
});

describe('an order the seller DID handle', () => {
  it('is left alone once the parcel has shipped, however long ago it was paid', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 30, shippingStatus: 'shipped' });
    const result = await runOrderSla(TODAY);
    expect(result.scanned).toBe(0);
    expect(await statusOf(id)).toBe('shipped');
  });

  // The fairness rule, and it is the whole reason the deadline reads the status table instead of
  // comparing against 'shipped': a collected order never passes through that status at all, so a
  // seller who packed it and is waiting for the buyer to turn up has done everything they control.
  it('is left alone when a self-pickup order is marked ready', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 5, shippingStatus: 'ready', deliveryMethod: 'pickup' });
    const result = await runOrderSla(TODAY);
    expect(result.scanned).toBe(0);
    expect(await statusOf(id)).toBe('ready');
  });

  // Same status, courier delivery: 'ready' is NOT the milestone there, so this one IS late.
  it('still catches a courier order stuck at ready', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 5, shippingStatus: 'ready' });
    await runOrderSla(TODAY);
    expect(await statusOf(id)).toBe('cancelled');
  });
});

describe('an order whose money never moved', () => {
  it('is never cancelled for lateness — there is nothing to give back', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 5, paymentStatus: 'pending' });
    const result = await runOrderSla(TODAY);
    expect(result.scanned).toBe(0);
    expect(await statusOf(id)).toBe('pending');
    expect(await moneyEventsFor(id)).toEqual([]);
  });
});

describe('the warning that comes first', () => {
  it('warns without cancelling, and names the day the cancellation lands', async () => {
    const id = await seedOrder({ paidDaysAgo: SHIP_WARNING_DAYS + 1 });

    const result = await runOrderSla(TODAY);

    expect(result.warned).toBe(1);
    expect(result.cancelled).toBe(0);
    expect(await statusOf(id)).toBe('pending');
    const notes = await notificationsFor();
    expect(notes.map((n) => n.title)).toEqual(['הזמנה ממתינה לשליחה']);
    // Keyed apart from the order id on purpose: the `new_order` notification already carries that
    // value, and the dedup lookback would have matched it — the seller would be "already warned"
    // about an order nobody had warned them about.
    expect(notes[0]!.related_id).toBe(`sla-late:${id}`);
  });

  it('says it once, not once a day', async () => {
    await seedOrder({ paidDaysAgo: SHIP_WARNING_DAYS + 1 });

    await runOrderSla(TODAY);
    const second = await runOrderSla(TODAY);

    expect(second.scanned).toBe(1);   // still late…
    expect(second.warned).toBe(0);    // …and still already told
    expect(await notificationsFor()).toHaveLength(1);
  });

  it('does not fire before the deadline', async () => {
    await seedOrder({ paidDaysAgo: SHIP_WARNING_DAYS - 2 });
    const result = await runOrderSla(TODAY);
    expect(result.scanned).toBe(0);
    expect(await notificationsFor()).toHaveLength(0);
  });
});

describe('the SQL prefilter is a net, never the rule', () => {
  // It errs WIDE by a day (the business calendar and a raw timestamp disagree by hours around a
  // boundary), so a row it lets through may still be 'ok'. What it must never do is drop one the
  // rule would have acted on.
  it('returns nothing the rule then calls ok', async () => {
    await seedOrder({ paidDaysAgo: SHIP_WARNING_DAYS + 3 });
    await seedOrder({ paidDaysAgo: SHIP_AUTO_CANCEL_DAYS + 3 });
    await seedOrder({ paidDaysAgo: 1 });

    const candidates = await getSlaCandidates(100, TODAY);
    expect(candidates.map((c) => c.state).sort()).toEqual(['overdue', 'warn']);
  });
});
