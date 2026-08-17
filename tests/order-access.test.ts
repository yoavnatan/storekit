import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { POST as returns } from '../src/pages/api/returns.js';
import { query, firstRow } from '../src/lib/db.js';
import { getOrderById, updateOrder } from '../src/lib/orders.js';
import { resolveOrderAccess } from '../src/lib/order-access.js';
import { orderToken, verifyOrderToken } from '../src/lib/order-token.js';

/**
 * Who may act on an order — the change that let a GUEST open a case about their own purchase.
 *
 * Guest checkout is the default here, so before this most buyers could not open a return, a
 * cancellation, or "it never arrived" at all: `/api/returns` required a session. A case is filed
 * against an ORDER (`return_requests.order_id`) and never against an account, so the account was
 * only ever how we recognised the person — and this replaces that recognition, and nothing else.
 *
 * Two properties are worth more than the happy path and are what this file is really for:
 *
 *   1. **Every miss looks identical.** "No such order", "wrong email" and "not yours" must be one
 *      answer, or an 8-character order reference becomes enumerable through the reply.
 *   2. **Purposes do not convert.** A link inviting somebody to rate a product must not open a case
 *      that ends in money moving.
 */

const noCookies = { get: () => undefined, set: () => {}, delete: () => {}, has: () => false } as unknown as AstroCookies;
const withSession = (value: string) => ({
  get: () => ({ value }), set: () => {}, delete: () => {}, has: () => true,
} as unknown as AstroCookies);

const post = (body: unknown, cookies: AstroCookies = noCookies): Promise<Response> => returns({
  request: new Request('http://localhost/api/returns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies,
  clientAddress: '127.0.0.1',
} as unknown as APIContext);

const REF = 'A1B2C3D4';
const EMAIL = 'guest@example.test';

/** A paid, delivered, guest order — no `buyer_id`, which is the whole point. */
async function guestOrder(ref = REF, email = EMAIL): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, checkout_ref, buyer_name, buyer_email, buyer_phone, buyer_city,
                         buyer_street, shipping_agorot, total_agorot, payment_status,
                         shipping_status, paid_at, shipped_at, delivered_at, created_at, updated_at)
     VALUES ($1, $2, 'דנה', $3, '0500000000', 'תל אביב', 'הרצל 1', 0, 5000, 'paid',
             'delivered', now(), now(), now(), now(), now())`,
    [id, ref, email],
  );
  await query(
    `INSERT INTO order_items (id, order_id, product_id, product_name, product_slug, store_slug,
                              store_name, price_agorot, qty, position)
     SELECT $1, $2, p.id, p.name, p.slug, 'keramika', 'קרמיקה', 5000, 1, 0
       FROM store_products p WHERE p.slug = 'agartal' LIMIT 1`,
    [crypto.randomUUID(), id],
  );
  await query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
     VALUES ($1, 'keramika', 'קרמיקה', 5000, 0)`,
    [id],
  );
  return id;
}

const caseCount = async (orderId: string): Promise<number> => {
  const row = await firstRow<{ n: string }>(
    'SELECT count(*) AS n FROM return_requests WHERE order_id = $1', [orderId]);
  return Number(row?.n ?? 0);
};

beforeEach(async () => {
  await query('DELETE FROM return_requests');
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  await query('DELETE FROM auth_attempts').catch(() => {});
});

describe('the three credentials', () => {
  it('accepts the order number with the address it was placed with', async () => {
    const id = await guestOrder();
    const access = await resolveOrderAccess({ orderRef: REF, email: EMAIL }, noCookies);
    expect(access?.order.id).toBe(id);
    expect(access?.proof).toBe('ref-email');
    // A guest has no account, and the case must record that rather than inventing one.
    expect(access?.buyerId).toBeNull();
  });

  it('is case-insensitive about both, because a person typing from a mail is', async () => {
    await guestOrder();
    expect(await resolveOrderAccess({ orderRef: 'a1b2c3d4', email: 'Guest@Example.Test' }, noCookies)).not.toBeNull();
  });

  it('refuses the right order number with the wrong address', async () => {
    await guestOrder();
    expect(await resolveOrderAccess({ orderRef: REF, email: 'someone@else.test' }, noCookies)).toBeNull();
  });

  it('refuses either half alone', async () => {
    await guestOrder();
    expect(await resolveOrderAccess({ orderRef: REF }, noCookies)).toBeNull();
    expect(await resolveOrderAccess({ email: EMAIL }, noCookies)).toBeNull();
  });

  it('never sends a malformed reference to the database', async () => {
    await guestOrder();
    // A reference is 8 hex characters. Anything else cannot match one, and a long request-supplied
    // string has no business reaching an indexed comparison.
    for (const bad of ['', 'ZZZZZZZZ', 'A1B2C3D', 'A1B2C3D4E', "' OR 1=1--", 'x'.repeat(5000)]) {
      expect(await resolveOrderAccess({ orderRef: bad, email: EMAIL }, noCookies), bad.slice(0, 12)).toBeNull();
    }
  });

  it('accepts a signed link, and only for its own order', async () => {
    const id = await guestOrder();
    const other = '00000000-0000-4000-8000-0000000000ff';
    expect((await resolveOrderAccess({ orderId: id, token: orderToken(id, 'help') }, noCookies))?.proof).toBe('token');
    expect(await resolveOrderAccess({ orderId: id, token: orderToken(other, 'help') }, noCookies)).toBeNull();
    expect(await resolveOrderAccess({ orderId: id, token: '' }, noCookies)).toBeNull();
  });

  it('does not let a REVIEW link open a case', async () => {
    // The whole reason the purpose is folded into the signing key: the review invitation is a
    // low-stakes "rate this", and cases end in money moving.
    const id = await guestOrder();
    expect(verifyOrderToken(id, 'help', orderToken(id, 'review'))).toBe(false);
    expect(await resolveOrderAccess({ orderId: id, token: orderToken(id, 'review') }, noCookies)).toBeNull();
  });

  it('does not let a session stand in for someone else\'s order', async () => {
    const id = await guestOrder();
    // A guest order has no `buyer_id`, so no session can equal it — the property that stopped the
    // old session-only check from ever matching one by accident.
    expect(await resolveOrderAccess({ orderId: id }, withSession('11111111-1111-4111-8111-000000000001'))).toBeNull();
  });
});

describe('/api/returns opens a case for a buyer with no account', () => {
  it('opens one from the order number and the address', async () => {
    const id = await guestOrder();
    const res = await post({ action: 'open', orderRef: REF, email: EMAIL, reason: 'not_arrived' });
    expect(res.status).toBe(201);
    expect(await caseCount(id)).toBe(1);
  });

  it('opens one from the mailed link, with nothing typed', async () => {
    const id = await guestOrder();
    const res = await post({ action: 'open', orderId: id, token: orderToken(id, 'help'), reason: 'damaged' });
    expect(res.status).toBe(201);
    expect(await caseCount(id)).toBe(1);
  });

  it('stores the buyer\'s own sentence, capped', async () => {
    const id = await guestOrder();
    await post({
      action: 'open', orderId: id, token: orderToken(id, 'help'), reason: 'damaged',
      note: 'ה'.repeat(900),
    });
    const row = await firstRow<{ buyer_note: string }>(
      'SELECT buyer_note FROM return_requests WHERE order_id = $1', [id]);
    // Refused at 500 rather than stored whole: the field is the ONE free-text exception on this
    // surface, and an uncapped one is the messaging channel arriving through a side door.
    expect(row!.buyer_note).toHaveLength(500);
  });

  it('answers 403 the SAME way for a wrong email, an unknown order and a bad token', async () => {
    const id = await guestOrder();
    const answers = await Promise.all([
      post({ action: 'open', orderRef: REF, email: 'wrong@example.test', reason: 'damaged' }),
      post({ action: 'open', orderRef: 'FFFFFFFF', email: EMAIL, reason: 'damaged' }),
      post({ action: 'open', orderId: id, token: 'nonsense', reason: 'damaged' }),
    ]);
    const bodies = await Promise.all(answers.map(async (r) => ({ status: r.status, body: await r.text() })));
    // Identical status AND identical body. A different sentence for "no such order" would make an
    // 8-character reference enumerable one request at a time.
    expect(bodies.map((b) => b.status)).toEqual([403, 403, 403]);
    expect(new Set(bodies.map((b) => b.body)).size).toBe(1);
    expect(await caseCount(id)).toBe(0);
  });

  it('refuses a reason that is not on the closed list', async () => {
    const id = await guestOrder();
    const res = await post({ action: 'open', orderId: id, token: orderToken(id, 'help'), reason: 'because' });
    expect(res.status).toBe(400);
    expect(await caseCount(id)).toBe(0);
  });

  it('still allows only ONE open case per order, whoever opened it', async () => {
    const id = await guestOrder();
    expect((await post({ action: 'open', orderRef: REF, email: EMAIL, reason: 'damaged' })).status).toBe(201);
    const second = await post({ action: 'open', orderRef: REF, email: EMAIL, reason: 'changed_mind' });
    expect(second.status).toBe(409);
    expect(await caseCount(id)).toBe(1);
  });

  it('refuses an order that is in no state to be returned', async () => {
    const id = await guestOrder();
    await updateOrder(id, { shippingStatus: 'cancelled' });
    const res = await post({ action: 'open', orderRef: REF, email: EMAIL, reason: 'damaged' });
    expect(res.status).toBe(409);
    expect(await caseCount(id)).toBe(0);
    expect((await getOrderById(id))!.shippingStatus).toBe('cancelled');
  });
});
