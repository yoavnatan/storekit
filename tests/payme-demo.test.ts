import { afterEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import { answerDemoPayme, DEMO_PAYME_BASE_URL, DEMO_PAYME_CLIENT_KEY } from '../src/lib/payme-demo.js';
import { isDemoMode, DEMO_APPROVAL_SECONDS } from '../src/lib/demo-mode.js';
import { isSandbox, paymeCredentials, paymeIsActive, PAYME_SUB_STATUS } from '../src/lib/payment-payme.js';

/**
 * The stand-in clearing company (`lib/payme-demo.ts`).
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * **That the demo cannot reach a real gateway.** The failure this guards against is not exotic: a
 * `.env` copied onto the demo host carries live PayMe keys, and a credentials function that
 * preferred them would put a portfolio site's clicks through somebody's real merchant account. So
 * demo mode is asserted to win over a populated environment, not merely over an empty one.
 *
 * **That the demo's answers keep the shape production parses.** A stand-in that answered in a
 * tidier shape than the real thing would exercise code paths production never takes, and the demo
 * would then be a demonstration of different software. The shape assertions below are copied from
 * what `payment-payme.ts` actually reads — an `items` ARRAY that the caller filters by id, PayMe's
 * six-value `sub_status` rather than the two-value one their own Generate page prints, and a
 * `sale_status` of exactly `completed`, which is the only string `saleIsPaid` accepts.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.DEMO_MODE = ORIGINAL.DEMO_MODE;
  process.env.PAYME_CLIENT_KEY = ORIGINAL.PAYME_CLIENT_KEY;
  if (ORIGINAL.DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  if (ORIGINAL.PAYME_CLIENT_KEY === undefined) delete process.env.PAYME_CLIENT_KEY;
});

describe('the flag, and what it costs to forget it', () => {
  it('is off unless it is exactly "1"', () => {
    process.env.DEMO_MODE = 'true';
    expect(isDemoMode()).toBe(false);
    process.env.DEMO_MODE = '1';
    expect(isDemoMode()).toBe(true);
  });

  it('hands out the local base URL rather than a real one, even with live keys present', () => {
    process.env.PAYME_CLIENT_KEY = 'a-real-looking-key';
    process.env.DEMO_MODE = '1';
    const creds = paymeCredentials();
    expect(creds?.baseUrl).toBe(DEMO_PAYME_BASE_URL);
    expect(creds?.clientKey).toBe(DEMO_PAYME_CLIENT_KEY);
    // The scheme is unresolvable on purpose: if this ever escapes the branch in `sendPayme` it must
    // fail loudly instead of quietly reaching something real.
    expect(DEMO_PAYME_BASE_URL.startsWith('demo://')).toBe(true);
  });

  it('counts as a sandbox, so every "never do this outside a sandbox" guard still holds', () => {
    process.env.DEMO_MODE = '1';
    expect(isSandbox(paymeCredentials()!)).toBe(true);
  });

  it('is active without PAYME_DEV_LIVE — the guard that flag exists for is a shared sandbox', () => {
    process.env.DEMO_MODE = '1';
    delete process.env.PAYME_DEV_LIVE;
    expect(paymeIsActive()).toBe(true);
  });

  it('changes nothing when it is off and nothing is configured', () => {
    delete process.env.DEMO_MODE;
    delete process.env.PAYME_CLIENT_KEY;
    expect(paymeCredentials()).toBe(null);
  });
});

describe('the answers production parses', () => {
  it('mints a merchant id carrying its own creation time, and reports it unapproved', async () => {
    const res = await answerDemoPayme('create-seller', {});
    expect(res.status_code).toBe(0);
    expect(String(res.seller_payme_id)).toMatch(/^demo-mrc-[0-9a-z]+-[0-9a-f]+$/);
    expect(res.seller_approved).toBe(false);
    // `readPublicKey` refuses an inactive key and stores nothing — a seller with no key can never
    // draw a card field again, so the demo must not hand out one that looks off.
    expect(res.seller_public_key).toMatchObject({ is_active: true });
    expect(String(res.seller_payme_secret).length).toBeGreaterThan(0);
  });

  it('holds a new business in review, then approves it — the wait is on screen, not skipped', async () => {
    const fresh = String((await answerDemoPayme('create-seller', {})).seller_payme_id);
    const pending = await answerDemoPayme('get-sellers', { seller_payme_id: fresh });
    expect((pending.items as Record<string, unknown>[])[0]!.seller_approved).toBe(false);

    // The same id, minted far enough in the past. `Date.now()` is not mocked: the id IS the clock.
    const old = `demo-mrc-${(Date.now() - (DEMO_APPROVAL_SECONDS + 5) * 1000).toString(36)}-abcd`;
    const done = await answerDemoPayme('get-sellers', { seller_payme_id: old });
    expect((done.items as Record<string, unknown>[])[0]!.seller_approved).toBe(true);
  });

  it('answers get-sellers with an ARRAY the caller filters, never a bare object', async () => {
    const res = await answerDemoPayme('get-sellers', { seller_payme_id: 'demo-mrc-1-x' });
    expect(Array.isArray(res.items)).toBe(true);
    // `payment-payme.ts` matches on the id rather than taking items[0] — `get-sales` was measured
    // ignoring its own filter. The demo must carry the field that match reads.
    expect((res.items as Record<string, unknown>[])[0]!.seller_payme_id).toBe('demo-mrc-1-x');
  });

  it('prefers the stored account over the id, so a seeded merchant can be approved from birth', async () => {
    const sellerId = '77777777-7777-4777-8777-000000000001';
    const ref = `demo-mrc-${Date.now().toString(36)}-seed`;
    await query('INSERT INTO sellers (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [sellerId, 'demo-payme@demo.local']);
    await query(
      `INSERT INTO seller_merchant_accounts (seller_id, provider_ref, created_at)
         VALUES ($1, $2, now() - interval '10 days')
       ON CONFLICT (seller_id) DO UPDATE SET provider_ref = EXCLUDED.provider_ref, created_at = EXCLUDED.created_at`,
      [sellerId, ref],
    );
    const res = await answerDemoPayme('get-sellers', { seller_payme_id: ref });
    // The id says "minted a moment ago"; the row says ten days. The row wins, which is what lets a
    // seeder back-date a showcase merchant into being approved.
    expect((res.items as Record<string, unknown>[])[0]!.seller_approved).toBe(true);
    await query('DELETE FROM seller_merchant_accounts WHERE seller_id = $1', [sellerId]);
    await query('DELETE FROM sellers WHERE id = $1', [sellerId]);
  });

  it('computes the market fee rather than echoing the caller — percentage plus the fixed part', async () => {
    const res = await answerDemoPayme('generate-sale', {
      sale_price: 10_000,        // ₪100, agorot
      market_fee: 10,            // 10% → 1000
      market_fee_fixed: 1.5,     // PayMe take this one in SHEKELS → 150 agorot
    });
    expect(res.sale_market_fee_total).toBe(1150);
    // The only status `saleIsPaid` accepts. Anything else silently produces an unpaid order.
    expect(res.sale_status).toBe('completed');
    expect(String(res.payme_sale_id).length).toBeGreaterThan(0);
  });

  it('opens a subscription ACTIVE and with no payment link — there is no page to send a seller to', async () => {
    const res = await answerDemoPayme('generate-subscription', {});
    expect(res.sub_status).toBe(PAYME_SUB_STATUS.active);
    expect('sub_url' in res).toBe(false);
    expect(String(res.sub_next_date)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('keeps the invoicing add-on switchable, and reports the switch back', async () => {
    const merchant = 'demo-mrc-vas-test';
    const before = await answerDemoPayme('get-vas-seller', { seller_payme_id: merchant });
    expect((before.items as Record<string, unknown>[])[0]!.vas_is_active).toBe(false);

    await answerDemoPayme('vas-enable', { seller_payme_id: merchant });
    const after = await answerDemoPayme('get-vas-seller', { seller_payme_id: merchant });
    const row = (after.items as Record<string, unknown>[])[0]!;
    expect(row.vas_is_active).toBe(true);
    // `seller-invoicing.ts` matches on the TYPE NAME, lower-cased. A row whose type it cannot
    // recognise means the invoicing card never renders and nobody would know why.
    expect(String(row.vas_type).toLowerCase()).toBe('invoicingservice');

    await answerDemoPayme('vas-disable', { seller_payme_id: merchant });
    expect(((await answerDemoPayme('get-vas-seller', { seller_payme_id: merchant })).items as Record<string, unknown>[])[0]!.vas_is_active).toBe(false);
  });

  it('returns PayMe\'s own ledger EMPTY rather than inventing money', async () => {
    // Fabricated transfers would put figures on the dashboard that disagree with the orders and the
    // reports beside them. Empty reads as "no transfers yet", which is true.
    for (const endpoint of ['get-transactions', 'get-withdrawals', 'get-future-withdrawals']) {
      expect((await answerDemoPayme(endpoint, {})).items).toEqual([]);
    }
  });

  it('refuses an endpoint it was never taught, by name', async () => {
    const res = await answerDemoPayme('generate-something-new', {});
    // Not `{status_code: 0}` with no fields — that surfaces three frames away as "succeeded
    // without a payme_sale_id", pointing at the caller instead of at this file.
    expect(res.status_code).not.toBe(0);
    expect(String(res.status_error_details)).toContain('generate-something-new');
  });
});

describe('the two constants repeated to avoid an import cycle', () => {
  it('still equal the enum they were copied from', async () => {
    // `payme-demo.ts` cannot import `payment-payme.ts` — that module imports IT. The copies are
    // two integers; this is what keeps them honest.
    expect((await answerDemoPayme('generate-subscription', {})).sub_status).toBe(PAYME_SUB_STATUS.active);
    const sellerId = '77777777-7777-4777-8777-000000000002';
    await query('INSERT INTO sellers (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [sellerId, 'demo-cancel@demo.local']);
    await query(
      `INSERT INTO seller_subscriptions (seller_id, provider_ref, tier, price_agorot, status, canceled_at)
         VALUES ($1, 'demo-sub-cancelled', 'basic', 9900, 2, now())
       ON CONFLICT (seller_id) DO UPDATE SET canceled_at = EXCLUDED.canceled_at`,
      [sellerId],
    );
    const listed = (await answerDemoPayme('get-subscriptions', {})).items as Record<string, unknown>[];
    expect(listed.find((s) => s.sub_payme_id === 'demo-sub-cancelled')?.sub_status).toBe(PAYME_SUB_STATUS.canceled);
    await query('DELETE FROM seller_subscriptions WHERE seller_id = $1', [sellerId]);
    await query('DELETE FROM sellers WHERE id = $1', [sellerId]);
  });
});
