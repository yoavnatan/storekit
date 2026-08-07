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
import { getOrderById } from '../src/lib/orders.js';
import { checkoutGroupKey } from '../src/lib/checkout-group.js';
import { MOCK_DECLINE_MARKER } from '../src/lib/payment.js';

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
