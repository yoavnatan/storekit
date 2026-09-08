/**
 * `/api/seller/own-clearing` — the route a seller connects his own clearing account through.
 *
 * The failure this file exists to make impossible: **one seller writing another seller's terminal
 * credentials.** Every payment that shop takes would land in the attacker's account, the shop would
 * look entirely normal, and the seller would find out from his bank. So the route may never read a
 * seller id from anywhere but the session, and these tests post one while the session says
 * otherwise.
 *
 * The second thing asserted here is that a secret never comes back out. The response is what the
 * settings screen renders, so anything in it is in the page's HTML.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/lib/db.js';

const SELLER_A = '11111111-1111-4111-8111-0000000c1001';
const SELLER_B = '11111111-1111-4111-8111-0000000c1002';

let SESSION: string | null = SELLER_A;
vi.mock('../src/lib/seller-auth.js', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/seller-auth')>('../src/lib/seller-auth')),
  getSellerSession: () => SESSION,
}));

const { POST, GET } = await import('../src/pages/api/seller/own-clearing.js');

function ctx(body: unknown) {
  return {
    request: new Request('http://localhost/api/seller/own-clearing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    cookies: { get: () => undefined },
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(async () => {
  SESSION = SELLER_A;
  for (const id of [SELLER_A, SELLER_B]) {
    await query(
      `INSERT INTO sellers (id, name, email, password_hash) VALUES ($1, 'T', $2, '')
         ON CONFLICT (id) DO NOTHING`,
      [id, `${id}@clearing-route.test`],
    );
  }
  await query('DELETE FROM seller_clearing_credentials WHERE seller_id = ANY($1)', [[SELLER_A, SELLER_B]]);
});

describe('who the credentials are written for', () => {
  it('writes them for the session, not for a seller id in the body', async () => {
    const res = await POST(ctx({ provider: 'hyp', masof: '1', apiKey: 'k', passp: 'p', sellerId: SELLER_B }));
    expect(res.status).toBe(200);

    const rows = await query<{ seller_id: string }>(
      'SELECT seller_id FROM seller_clearing_credentials WHERE seller_id = ANY($1)',
      [[SELLER_A, SELLER_B]],
    );
    expect(rows.rows.map((r) => r.seller_id)).toEqual([SELLER_A]);
  });

  it('refuses a caller with no session', async () => {
    SESSION = null;
    expect((await POST(ctx({ provider: 'hyp', masof: '1' }))).status).toBe(401);
    expect((await GET({ cookies: { get: () => undefined } } as never)).status).toBe(401);
  });
});

describe('which providers the route accepts', () => {
  it('every provider a seller may pick has fields that were read from the vendor', async () => {
    // A provider offered with no verified fields is a seller filling in a form that can never work,
    // and he finds out on his first real buyer rather than here.
    const { connectableProviders } = await import('../src/lib/clearing-providers.js');
    for (const p of connectableProviders()) {
      expect(p.fieldsVerified && p.fields.length > 0, `${p.id} is offered but unaskable`).toBe(true);
    }
  });

  it('refuses the ones we cannot talk to yet, by name', async () => {
    // uPay (owner, 2026-09-08) is the first entry we could not settle from the vendor — they sell
    // the API document rather than publishing it, so the fields are unknown and the entry is listed
    // rather than offered. The refusal has to happen HERE: without it a seller would pick it from a
    // future settings screen, be told it saved, and find his shop still cannot take money.
    const { CLEARING_PROVIDERS } = await import('../src/lib/clearing-providers.js');
    const coming = CLEARING_PROVIDERS.filter((p) => !p.fieldsVerified);
    expect(coming.length, 'this test asserts nothing if every provider is verified').toBeGreaterThan(0);
    for (const p of coming) {
      const res = await POST(ctx({ provider: p.id }));
      expect(res.status, `${p.id} was accepted`).toBe(400);
      expect(await res.json()).toMatchObject({ field: 'provider' });
    }
  });

  it('refuses a provider that does not exist', async () => {
    expect((await POST(ctx({ provider: 'stripe' }))).status).toBe(400);
  });
});

describe('what comes back', () => {
  it('never contains a secret the seller pasted', async () => {
    const res = await POST(ctx({ provider: 'hyp', masof: '0010131918', apiKey: 'SECRET-KEY-VALUE', passp: 'pw' }));
    const text = await res.text();
    expect(text).not.toContain('SECRET-KEY-VALUE');
    expect(text).not.toContain('pw');
    expect(JSON.parse(text).fields.apiKey.hint).toBe('••••ALUE');
  });

  it('reports what is still missing rather than refusing a partial paste', async () => {
    const res = await POST(ctx({ provider: 'hyp', masof: '1' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.missing.sort()).toEqual(['apiKey', 'passp']);
    expect(body.canTakePayments).toBe(false);
  });
});
