import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { POST } from '../src/pages/api/checkout.js';
import { query } from '../src/lib/db.js';

/**
 * A purchase completing on the portfolio demonstration — the flow the whole thing exists to show.
 *
 * **This file is here because that flow was broken and everything else was green.** In demo mode
 * `activePaymeCredentials()` answers with the stand-in gateway's credentials, so `/api/checkout`
 * takes the SPLIT path — and the split path opens by refusing a request with no buyer token, which
 * is every request the demo can make, because the demo collects no card. Every purchase would have
 * answered `missing-card`, on the day the link was handed to somebody. No existing test could see
 * it: they all run with no PayMe configured, which is the other branch entirely.
 *
 * The assertions are about the SPLIT actually running, not merely about a 201. The point of minting
 * the token server-side rather than skipping the split is that the demonstration exercises
 * `authorizeCart`, `captureSlices`, the per-store market fee and the separate shipping leg exactly
 * as production does — if this file only checked for an order row, that whole architecture could
 * quietly stop being demonstrated and the test would still pass.
 *
 * **One purchase, asserted several ways.** Written first as a checkout per assertion, which was
 * wrong on its own terms — each one re-ran the same charge to look at a different column.
 */

const noCookies = { get: () => undefined } as unknown as AstroCookies;

const ctx = (body: unknown): APIContext => ({
  request: new Request('https://example.test/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies: noCookies,
} as unknown as APIContext);

/** The two-store fixture cart, minus any card token — which is the whole case under test. */
const cart = (over: Record<string, unknown> = {}) => ({
  buyerName: 'מתרשם',
  buyerEmail: 'demo-visitor@example.test',
  buyerPhone: '0501234567',
  buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
  items: [
    { storeSlug: 'keramika', productSlug: 'agartal', qty: 1, selectedVariants: { צבע: 'כחול' } },
    { storeSlug: 'tachshitim', productSlug: 'agartal', qty: 1 },
  ],
  idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
  ...over,
});

const KERAMIKA = '22222222-2222-4222-8222-000000000001';
const TACHSHITIM = '22222222-2222-4222-8222-000000000002';
const ENV_KEYS = ['DEMO_MODE', 'PAYME_CLIENT_KEY', 'PAYME_DEV_LIVE', 'PAYME_BASE_URL'] as const;
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(async () => {
  // Stock, and a PRICE. The fixture's אגרטל costs 91 agorot and PayMe refuse any sale under ₪5
  // (`PAYME_MIN_SALE_AGOROT`), so the split answered `store-below-minimum` on the whole cart —
  // the route working correctly on data no real shop would have. Set explicitly rather than by
  // buying twelve of them, so the assertions are about the demo and not about a quantity that
  // happens to clear a threshold.
  await query(`UPDATE store_products SET stock = 7, price_agorot = 12900 WHERE store_id = $1 AND slug = 'agartal'`, [KERAMIKA]);
  await query(`UPDATE store_products SET stock = 5, price_agorot = 8900 WHERE store_id = $1 AND slug = 'agartal'`, [TACHSHITIM]);
  for (const t of ['money_events', 'checkout_idempotency', 'order_items', 'order_stores', 'orders']) {
    await query(`DELETE FROM ${t}`);
  }
  await query('DELETE FROM seller_merchant_accounts');

  // A clearing account per seller, approved and back-dated — what `seed:portfolio` writes. Without
  // it `planSplit` has no merchant to charge and refuses the cart before any of this is reached.
  const { rows } = await query<{ seller_id: string }>(
    `SELECT DISTINCT seller_id FROM stores WHERE slug = ANY($1)`, [['keramika', 'tachshitim']]);
  for (const { seller_id } of rows) {
    await query(
      `INSERT INTO seller_merchant_accounts (seller_id, provider_ref, callback_secret, public_key, approved, created_at)
            VALUES ($1, $2, 'secret', 'demo-pk', true, now() - interval '30 days')`,
      [seller_id, `demo-mrc-${seller_id}`]);
  }
  process.env.DEMO_MODE = '1';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
});

describe('a visitor with no card completes a purchase', () => {
  it('writes one order per store, really charged, with the stock off both shelves', async () => {
    const res = await POST(ctx(cart()));
    // The body read ONCE, into a variable, and used as the failure message: `missing-card` and
    // `cannot-charge` are entirely different faults and a bare "expected 201, got 409" says
    // neither. Not two `res.clone()` calls — `clone()` tees the stream, and a second clone taken
    // while the first tee is unconsumed never resolves.
    const body = await res.text();
    expect(res.status, body).toBe(201);

    const orders = await query<{ payment_ref: string; payment_status: string }>(
      'SELECT payment_ref, payment_status FROM orders');
    expect(orders.rows).toHaveLength(2);
    for (const row of orders.rows) {
      expect(row.payment_status).toBe('paid');
      // `demo-sale-…` is what `payme-demo.ts` answers `generate-sale` with. Its presence on BOTH
      // rows is the proof that the capture really ran per store rather than the split being
      // skipped — the difference between demonstrating this architecture and bypassing it.
      expect(row.payment_ref).toMatch(/^demo-sale-/);
    }

    const stock = await query<{ store_id: string; stock: number }>(
      `SELECT store_id, stock FROM store_products WHERE slug = 'agartal' AND store_id = ANY($1)`,
      [[KERAMIKA, TACHSHITIM]]);
    expect(new Map(stock.rows.map((r) => [r.store_id, r.stock])))
      .toEqual(new Map([[KERAMIKA, 6], [TACHSHITIM, 4]]));
  }, 20_000);

  it('still refuses a cardless purchase when demo mode is OFF', async () => {
    /* The guard that keeps the mint from becoming a free checkout on a real deployment. Asserted
       rather than trusted: it sits inside the most sensitive route in the application.

       A gateway is configured for this case — otherwise the route takes the mock path and the
       branch under test is never reached — and its base URL points at a closed port, so a broken
       guard fails in milliseconds with a connection error instead of waiting out `outbound-fetch`'s
       timeout. A test that hangs on a regression is a test nobody keeps. */
    delete process.env.DEMO_MODE;
    process.env.PAYME_CLIENT_KEY = 'not-a-real-key';
    process.env.PAYME_DEV_LIVE = '1';
    process.env.PAYME_BASE_URL = 'http://127.0.0.1:1/';

    const res = await POST(ctx(cart()));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'missing-card' });
    const { rows } = await query<{ n: number }>('SELECT count(*)::int AS n FROM orders');
    expect(rows[0]!.n).toBe(0);
  }, 20_000);
});
