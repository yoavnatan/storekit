/**
 * The route the seller's two buttons post to — and the one bug that made both of them do nothing.
 *
 * `checkout.ts` writes the "this order owes an invoice" row at purchase, so the settle path is an
 * UPDATE. Every order placed BEFORE that code existed has no such row, which on a real installation
 * is the whole back catalogue: the UPDATE matched nothing, the route answered 404, and the button
 * was inert on every order the seller had. The route backfills — and the backfill is exactly where
 * the authorization has to be re-proved, because the UPDATE's own `seller_id` filter was doing that
 * job and an INSERT has no filter at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { query, firstRow } from '../src/lib/db.js';
import { POST } from '../src/pages/api/seller/order-invoice.js';
import { setSellerSession } from '../src/lib/seller-auth.js';
import { getBuyerInvoiceForOrder } from '../src/lib/invoicing/buyer-invoice.js';

const CLOUD = 'test-cloud';
process.env.PUBLIC_CLOUDINARY_CLOUD_NAME = CLOUD;

/** A real signed session cookie for `sellerId`, produced by the code that issues them — a
 *  hand-written token would prove the test can forge one, not that the route accepts a real one. */
function cookiesFor(sellerId: string | null): AstroCookies {
  let value: string | undefined;
  if (sellerId) {
    setSellerSession({ set: (_n: string, v: string) => { value = v; } } as unknown as AstroCookies, sellerId);
  }
  return { get: () => (value ? { value } : undefined) } as unknown as AstroCookies;
}

const ctx = (sellerId: string | null, body: unknown): APIContext => ({
  request: new Request('https://example.test/api/seller/order-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies: cookiesFor(sellerId),
} as unknown as APIContext);

async function makeSeller(): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, business_type, created_at)
     VALUES ($1, 'Route Test', $2, '', 'licensed', now())`,
    [id, `route-${id}@example.com`],
  );
  return id;
}

async function makeStore(sellerId: string, slug: string): Promise<void> {
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [crypto.randomUUID(), sellerId, slug, slug],
  );
}

/** A paid order carrying one store's slice — the shape `checkout.ts` leaves behind, minus the
 *  invoice row, which is precisely the state this route has to cope with. */
async function makePaidOrder(slug: string, paymentStatus = 'paid'): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO orders (id, buyer_name, buyer_email, buyer_phone, total_agorot, payment_status, shipping_status)
     VALUES ($1, 'Buyer', 'b@example.com', '050', 12000, $2, 'pending')`,
    [id, paymentStatus],
  );
  await query(
    `INSERT INTO order_items (id, order_id, product_name, store_slug, store_name, price_agorot, qty, position)
     VALUES ($1, $2, 'פריט', $3, $3, 10000, 1, 0)`,
    [crypto.randomUUID(), id, slug],
  );
  await query(
    `INSERT INTO order_stores (order_id, store_slug, store_name, subtotal_agorot, shipping_agorot)
     VALUES ($1, $2, $2, 10000, 2000)`,
    [id, slug],
  );
  return id;
}

let sellerId = '';
let slug = '';

beforeEach(async () => {
  sellerId = await makeSeller();
  slug = `route-shop-${crypto.randomUUID().slice(0, 8)}`;
  await makeStore(sellerId, slug);
});

describe('an order that predates the invoice row', () => {
  it('settles anyway — the row is planned first, then marked', async () => {
    const orderId = await makePaidOrder(slug);
    expect(await getBuyerInvoiceForOrder(orderId)).toHaveLength(0);

    const res = await POST(ctx(sellerId, { orderId, mode: 'handover' }));
    expect(res.status).toBe(200);

    const [state] = await getBuyerInvoiceForOrder(orderId);
    expect(state.mode).toBe('handover');
    // Goods only — the backfill goes through `planBuyerInvoice`, so it cannot disagree with the
    // amount the checkout path would have written.
    const row = await firstRow<{ amount_agorot: string }>(
      'SELECT amount_agorot FROM invoice_documents WHERE order_id = $1', [orderId],
    );
    expect(Number(row!.amount_agorot)).toBe(10_000);
  });

  it("refuses another seller's order and writes nothing", async () => {
    const orderId = await makePaidOrder(slug);
    const intruder = await makeSeller();

    const res = await POST(ctx(intruder, { orderId, mode: 'handover' }));
    expect(res.status).toBe(404);
    // The absence of a row is the assertion that matters: a backfill that authorized nothing would
    // have CREATED one here, under the intruder's own seller id.
    expect(await getBuyerInvoiceForOrder(orderId)).toHaveLength(0);
  });

  it('refuses an order whose money was never taken', async () => {
    // `failed`, not `cancelled`: the orders table's own CHECK allows pending/paid/failed, and
    // `moneyWasTaken` is false for both of the first two. A tax document for a charge that never
    // completed would put a figure on the seller's books with nothing behind it.
    const orderId = await makePaidOrder(slug, 'failed');
    const res = await POST(ctx(sellerId, { orderId, mode: 'handover' }));
    expect(res.status).toBe(404);
    expect(await getBuyerInvoiceForOrder(orderId)).toHaveLength(0);
  });
});

describe('the ordinary guards', () => {
  it('rejects a signed-out caller', async () => {
    const orderId = await makePaidOrder(slug);
    expect((await POST(ctx(null, { orderId, mode: 'handover' }))).status).toBe(401);
  });

  it('rejects a mode it does not know', async () => {
    const orderId = await makePaidOrder(slug);
    expect((await POST(ctx(sellerId, { orderId, mode: 'posted' }))).status).toBe(400);
  });

  it('rejects an upload whose file is not in our storage, and settles nothing', async () => {
    const orderId = await makePaidOrder(slug);
    const res = await POST(ctx(sellerId, { orderId, mode: 'upload', documentUrl: 'https://evil.example.com/x.pdf' }));

    expect(res.status).toBe(404);
    // The row may now exist (the backfill ran before the URL was judged) but it must still be OWED —
    // a refused upload that left the invoice marked provided is the worst outcome here.
    const found = await getBuyerInvoiceForOrder(orderId);
    if (found.length) expect(found[0].status).toBe('pending');
  });
});
