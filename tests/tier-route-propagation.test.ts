/**
 * The ORDER `POST /api/seller/tier` does its two writes in, which is the whole fix.
 *
 * Until 2026-08-24 the route wrote the plan and stopped. For a seller who was already being charged
 * that was a money bug with no symptom: every report, every commission line and the dashboard moved
 * to the new plan, PayMe went on charging the old amount, and neither side had any reason to
 * mention it.
 *
 * The answer is not a refusal (owner: *"למה לבטל את המנוי? זה רק להחליף את ההוראת קבע שלו"*) — the
 * standing order is patched at PayMe, and a refusal must leave the shop on the plan the card is
 * actually paying for. So the property worth pinning is not "the route calls a function"; it is
 * that **the two can never end apart**:
 *
 *   · gateway refuses → the plan is rolled back, and the seller keeps the one he is paying for;
 *   · gateway accepts → the plan stands, and the answer tells the page WHEN it takes effect.
 *
 * The plan moved from the account to the STORE the same day (`lib/store-plan.ts`), so the route now
 * takes a store id and proves ownership of it before writing anything — an id in a body is not a
 * permission, and without that check a session could move somebody else's shop onto another plan.
 *
 * The modules underneath are mocked on purpose: `tests/seller-subscription.test.ts` owns what the
 * price sync does, and this file owns what the route does with its answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  /** Every plan actually written to the store, in order. A refusal must leave `['enterprise',
   *  'starter']` — written, then put back — and never a bare `['enterprise']`. */
  written: [] as string[],
  /** Whether the store belongs to this seller. `false` is the "an id is not a permission" case. */
  owned: true,
  sync: { status: 'not-paying' } as
    | { status: 'not-paying' }
    | { status: 'updated'; priceAgorot: number; storeFees: unknown[]; nextCharge?: string }
    | { status: 'reset' }
    | { status: 'failed'; error: string },
}));

vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerSession: () => 'seller-1',
  getSellerById: async () => ({ id: 'seller-1' }),
}));
vi.mock('../src/lib/store-ownership.js', () => ({
  ownedStore: async () => (rig.owned ? { id: 'store-1', sellerId: 'seller-1', tier: 'starter' } : null),
}));
vi.mock('../src/lib/stores.js', () => ({ getStoresBySellerId: async () => [] }));
vi.mock('../src/lib/store-plan.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/store-plan.js')>('../src/lib/store-plan.js');
  return {
    ...actual,
    setStoreTier: async (_id: string, tier: string) => { rig.written.push(tier); return tier; },
  };
});
vi.mock('../src/lib/seller-subscription.js', () => ({
  syncSubscriptionPrice: async () => rig.sync,
}));

const { POST } = await import('../src/pages/api/seller/tier.ts');

function post(tier: string): Promise<Response> {
  const request = new Request('https://example.test/api/seller/tier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier, storeId: 'store-1' }),
  });
  // Only the two things the route reads are supplied; anything else it touched would fail loudly
  // here rather than silently in production.
  return POST({ request, cookies: {} } as never);
}

beforeEach(() => {
  rig.written = [];
  rig.owned = true;
  rig.sync = { status: 'not-paying' };
});

describe('a plan change that PayMe refused', () => {
  it('leaves the store on the plan the card is actually paying for', async () => {
    rig.sync = { status: 'failed', error: 'subscription not active' };
    const res = await post('enterprise');

    expect(res.status).toBe(502);
    // The one assertion this file exists for. A plan left standing beside a gateway that refused is
    // the original defect, restored. It is written provisionally — the price has to be derived from
    // the row — and the last word must be the plan he had.
    expect(rig.written).toEqual(['enterprise', 'starter']);
  });

  it('answers 502 rather than 400 — the request was fine, the gateway was not', async () => {
    rig.sync = { status: 'failed', error: 'gateway down' };
    const res = await post('pro');
    const body = await res.json() as { gateway?: boolean; error?: string };
    // The page shows a sentence saying the plan did NOT change, and it must be able to tell this
    // apart from a rejected tier id, which is the seller's problem to fix and this is not.
    expect(body.gateway).toBe(true);
    expect(res.status).toBe(502);
  });

  it('leaks nothing of what the gateway said', async () => {
    rig.sync = { status: 'failed', error: 'MPL17873-13741TOF sub not active' };
    const body = await (await post('pro')).json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('MPL17873');
  });
});

describe('a plan change that went through', () => {
  it('records the tier and tells the page it starts at the next charge', async () => {
    rig.sync = { status: 'updated', priceAgorot: 19900, storeFees: [], nextCharge: '2026-09-23 10:00:00' };
    const res = await post('enterprise');
    const body = await res.json() as { ok?: boolean; tier?: string; fromNextCharge?: boolean; nextCharge?: string };

    expect(res.status).toBe(200);
    expect(rig.written).toEqual(['enterprise']);
    // Without this flag the page would tell a paying seller his plan changed and leave out the only
    // part that is about his money.
    expect(body).toMatchObject({ ok: true, tier: 'enterprise', fromNextCharge: true, nextCharge: '2026-09-23 10:00:00' });
  });

  it('says nothing about a next charge for a seller who is not paying yet', async () => {
    rig.sync = { status: 'not-paying' };
    const body = await (await post('growth')).json() as { fromNextCharge?: boolean };
    expect(rig.written).toEqual(['growth']);
    // He has no standing order, so there is no "from when" to name — the plan simply is what the
    // first subscription will be created at.
    expect(body.fromNextCharge).toBe(false);
  });

  it('records the tier when an unpaid subscription was discarded, and names no charge', async () => {
    rig.sync = { status: 'reset' };
    const body = await (await post('enterprise')).json() as { ok?: boolean; fromNextCharge?: boolean };
    expect(rig.written).toEqual(['enterprise']);
    // Nothing is being charged yet — the plan is simply what the next subscription is created at,
    // so there is no "from when" to promise.
    expect(body).toMatchObject({ ok: true, fromNextCharge: false });
  });

  it('still refuses a tier that is not one of ours, before any of this', async () => {
    const res = await post('platinum');
    expect(res.status).toBe(400);
    expect(rig.written).toEqual([]);
  });
});

describe('a store id is not a permission', () => {
  it('refuses a store this session does not own, and writes nothing', async () => {
    // A session proves an ACCOUNT. Without this check anyone with one could move another seller's
    // shop onto the dearest plan — or the cheapest, and take the commission with it.
    rig.owned = false;
    const res = await post('enterprise');
    expect(res.status).toBe(404);
    expect(rig.written).toEqual([]);
  });
});
