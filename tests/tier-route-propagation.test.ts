/**
 * The ORDER `POST /api/seller/tier` does two writes in, which is the whole fix.
 *
 * Until 2026-08-24 the route wrote `sellers.tier` and stopped. For a seller who was already being
 * charged that was a money bug with no symptom: every report, every commission line and the
 * dashboard moved to the new plan, PayMe went on charging the old amount, and neither side had any
 * reason to mention it. `lib/seller-tier.ts` had documented the danger and exported
 * `sellerMayChangeTier`; nothing called it.
 *
 * The answer is not a refusal (owner: *"למה לבטל את המנוי? זה רק להחליף את ההוראת קבע שלו"*) — the
 * standing order is patched at PayMe and the tier is written only if they accepted. So the property
 * worth pinning is not "the route calls a function"; it is that **the two writes can never happen
 * in the other order, and never happen apart**:
 *
 *   · gateway refuses → nothing is recorded, and the seller keeps the plan he is paying for;
 *   · gateway accepts → the tier is recorded, and the answer tells the page WHEN it takes effect.
 *
 * The modules underneath are mocked on purpose: `tests/seller-subscription.test.ts` owns what the
 * propagation does, and this file owns what the route does with its answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  /** Every tier actually recorded on the account. Empty is the assertion in the failure case. */
  written: [] as string[],
  propagation: { status: 'not-paying' } as
    | { status: 'not-paying' }
    | { status: 'updated'; nextCharge?: string }
    | { status: 'reset' }
    | { status: 'failed'; error: string },
}));

vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerSession: () => 'seller-1',
  getSellerById: async () => ({ id: 'seller-1', tier: 'starter' }),
}));
vi.mock('../src/lib/seller-tier.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/seller-tier.js')>('../src/lib/seller-tier.js');
  return {
    ...actual,
    setSellerTier: async (_id: string, tier: string) => { rig.written.push(tier); return tier; },
  };
});
vi.mock('../src/lib/seller-subscription.js', () => ({
  propagateTierToSubscription: async () => rig.propagation,
}));

const { POST } = await import('../src/pages/api/seller/tier.ts');

function post(tier: string): Promise<Response> {
  const request = new Request('https://example.test/api/seller/tier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  // Only the two things the route reads are supplied; anything else it touched would fail loudly
  // here rather than silently in production.
  return POST({ request, cookies: {} } as never);
}

beforeEach(() => {
  rig.written = [];
  rig.propagation = { status: 'not-paying' };
});

describe('a plan change that PayMe refused', () => {
  it('records no tier at all', async () => {
    rig.propagation = { status: 'failed', error: 'subscription not active' };
    const res = await post('enterprise');

    expect(res.status).toBe(502);
    // The one assertion this file exists for. A tier written beside a gateway that refused is the
    // original defect, restored.
    expect(rig.written).toEqual([]);
  });

  it('answers 502 rather than 400 — the request was fine, the gateway was not', async () => {
    rig.propagation = { status: 'failed', error: 'gateway down' };
    const res = await post('pro');
    const body = await res.json() as { gateway?: boolean; error?: string };
    // The page shows a sentence saying the plan did NOT change, and it must be able to tell this
    // apart from a rejected tier id, which is the seller's problem to fix and this is not.
    expect(body.gateway).toBe(true);
    expect(res.status).toBe(502);
  });

  it('leaks nothing of what the gateway said', async () => {
    rig.propagation = { status: 'failed', error: 'MPL17873-13741TOF sub not active' };
    const body = await (await post('pro')).json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('MPL17873');
  });
});

describe('a plan change that went through', () => {
  it('records the tier and tells the page it starts at the next charge', async () => {
    rig.propagation = { status: 'updated', nextCharge: '2026-09-23 10:00:00' };
    const res = await post('enterprise');
    const body = await res.json() as { ok?: boolean; tier?: string; fromNextCharge?: boolean; nextCharge?: string };

    expect(res.status).toBe(200);
    expect(rig.written).toEqual(['enterprise']);
    // Without this flag the page would tell a paying seller his plan changed and leave out the only
    // part that is about his money.
    expect(body).toMatchObject({ ok: true, tier: 'enterprise', fromNextCharge: true, nextCharge: '2026-09-23 10:00:00' });
  });

  it('says nothing about a next charge for a seller who is not paying yet', async () => {
    rig.propagation = { status: 'not-paying' };
    const body = await (await post('growth')).json() as { fromNextCharge?: boolean };
    expect(rig.written).toEqual(['growth']);
    // He has no standing order, so there is no "from when" to name — the plan simply is what the
    // first subscription will be created at.
    expect(body.fromNextCharge).toBe(false);
  });

  it('records the tier when an unpaid subscription was discarded, and names no charge', async () => {
    rig.propagation = { status: 'reset' };
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
