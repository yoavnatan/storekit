/**
 * `/api/seller/reports?report=payouts` — the accounting report, and the one question its shape
 * raises that the other three do not.
 *
 * Every other report on this route is SCOPED by `storeSlug`: the rows come from the store, and the
 * store is resolved inside `getStoresBySellerId`, so naming somebody else's slug reads nothing. The
 * payouts report cannot work that way — a payout is one bank transfer per registered business and
 * belongs to the ACCOUNT — so its rows come from the session's `sellerId` and the slug is doing a
 * different job: it proves the caller has a store and it names the export file.
 *
 * That is exactly the shape `lib/store-ownership.ts` exists to warn about, pointed the other way:
 * *an id is not a permission*. The failure available here is a route that reads `store.sellerId`
 * (or worse, a `sellerId` from the query string) and hands one seller another's transfer history.
 * So the tests below assert the two halves separately — the slug still has to resolve, AND the rows
 * that come back are the SESSION's regardless of which of the caller's stores was named.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/lib/db.js';

const SELLER_A = '11111111-1111-4111-8111-0000000000c1';
const SELLER_B = '11111111-1111-4111-8111-0000000000c2';
const STORE_A1 = '22222222-2222-4222-8222-0000000000c1';
const STORE_A2 = '22222222-2222-4222-8222-0000000000c2';
const STORE_B1 = '22222222-2222-4222-8222-0000000000c3';
const SLUG_A1 = 'rep-shop-a1';
const SLUG_A2 = 'rep-shop-a2';
const SLUG_B1 = 'rep-shop-b1';

let SESSION: string | null = SELLER_A;
vi.mock('../src/lib/seller-auth.js', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/seller-auth')>('../src/lib/seller-auth')),
  getSellerSession: () => SESSION,
}));

const { GET } = await import('../src/pages/api/seller/reports.js');

function ctx(params: Record<string, string>) {
  const url = new URL('http://localhost/api/seller/reports');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return {
    request: new Request(url),
    cookies: { get: () => undefined },
  } as unknown as Parameters<typeof GET>[0];
}

async function seedSeller(id: string, email: string): Promise<void> {
  await query(
    `INSERT INTO sellers (id, name, email, password_hash, created_at) VALUES ($1, 'R', $2, '', now())`,
    [id, email],
  );
}

async function seedStore(id: string, sellerId: string, slug: string): Promise<void> {
  await query(
    `INSERT INTO stores (id, seller_id, slug, name, tagline, description, colors, created_at)
     VALUES ($1, $2, $3, 'Report Shop', '', '', '{"primary":"#000","accent":"#111"}'::jsonb, now())`,
    [id, sellerId, slug],
  );
}

beforeEach(async () => {
  SESSION = SELLER_A;
  for (const id of [SELLER_A, SELLER_B]) {
    await query('DELETE FROM seller_payouts WHERE seller_id = $1', [id]);
    await query('DELETE FROM stores WHERE seller_id = $1', [id]);
    await query('DELETE FROM sellers WHERE id = $1', [id]);
  }
  await seedSeller(SELLER_A, `rep-a-${SELLER_A}@example.com`);
  await seedSeller(SELLER_B, `rep-b-${SELLER_B}@example.com`);
  await seedStore(STORE_A1, SELLER_A, SLUG_A1);
  await seedStore(STORE_A2, SELLER_A, SLUG_A2);
  await seedStore(STORE_B1, SELLER_B, SLUG_B1);

  // One transfer each, distinguishable by amount.
  await query(
    `INSERT INTO seller_payouts (seller_id, period_key, amount_agorot, commission_agorot, sent_at, status)
     VALUES ($1, '2026-07', 111100, 11100, '2026-08-03T09:00:00Z', 'paid'),
            ($2, '2026-07', 999900, 99900, '2026-08-03T09:00:00Z', 'paid')`,
    [SELLER_A, SELLER_B],
  );
});

const RANGE = { from: '2026-08-01', to: '2026-08-31' };

describe('the payouts report belongs to the ACCOUNT, not to the store named in the query', () => {
  it('refuses a caller with no session', async () => {
    SESSION = null;
    expect((await GET(ctx({ report: 'payouts', storeSlug: SLUG_A1, ...RANGE }))).status).toBe(401);
  });

  it('404s a slug the session does not own, so it cannot be used as a probe', async () => {
    // The slug is real — it is seller B's. A 404 rather than a 403 is this route's existing stance
    // everywhere: the caller learns nothing about whether the store exists.
    const res = await GET(ctx({ report: 'payouts', storeSlug: SLUG_B1, ...RANGE }));
    expect(res.status).toBe(404);
  });

  it('returns the SESSION\'s transfers, never the named store\'s owner\'s', async () => {
    const res = await GET(ctx({ report: 'payouts', storeSlug: SLUG_A1, ...RANGE }));
    const body = await res.json() as { rows: { amountAgorot: number }[]; totals: { amountAgorot: number } };
    expect(body.rows.map((r) => r.amountAgorot)).toEqual([111100]);
    expect(body.totals.amountAgorot).toBe(111100);
  });

  it('answers the same for EITHER of the seller\'s stores — the report is not per store', async () => {
    // The invariant the label "מכל החנויות" promises. A per-store split here would be a number no
    // bank transfer ever matches, and a seller reconciling two shops would double-count.
    const one = await (await GET(ctx({ report: 'payouts', storeSlug: SLUG_A1, ...RANGE }))).json();
    const two = await (await GET(ctx({ report: 'payouts', storeSlug: SLUG_A2, ...RANGE }))).json();
    expect(two).toEqual(one);
  });

  it('honours the period, and needs one', async () => {
    const outside = await (await GET(ctx({ report: 'payouts', storeSlug: SLUG_A1, from: '2026-09-01', to: '2026-09-30' }))).json() as { rows: unknown[] };
    expect(outside.rows).toEqual([]);
    // Unlike `stock`, this report is windowed — a missing range must be a refusal rather than a
    // silent "all time", which would hand a bookkeeper a file whose name promises a month.
    expect((await GET(ctx({ report: 'payouts', storeSlug: SLUG_A1 }))).status).toBe(400);
  });

  it('exports a CSV that carries the same rows and never caches', async () => {
    const res = await GET(ctx({ report: 'payouts', storeSlug: SLUG_A1, format: 'csv', ...RANGE }));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('2026-08-03');
    expect(body).toContain('1111.00');
    // Seller B's transfer must not appear in a file seller A downloads.
    expect(body).not.toContain('9999.00');
  });
});
