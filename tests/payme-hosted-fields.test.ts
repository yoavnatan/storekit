/**
 * The public key the browser needs to draw PayMe's card fields.
 *
 * Small surface, and every case here is one where drawing the fields would be WRONG: a seller PayMe
 * have not approved (his checkout is refused anyway, so a card form would collect a card for a
 * purchase that cannot complete), a store nobody has heard of, and the ordinary pre-gateway state.
 * The rule they share: `{ active: false }` is an answer, never an error — the caller's behaviour is
 * identical for all of them, and a failure status would push the page into an error branch for a
 * state that is not a failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  configured: true,
  sandbox: true,
  store: null as null | { sellerId: string },
  account: null as null | { publicKey: string; approved: boolean },
}));

vi.mock('../src/lib/stores.js', () => ({
  getStoreBySlugOrPrevious: async (slug: string) => (slug === 'known' ? state.store : null),
}));

vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantAccountFor: async () => state.account,
}));

vi.mock('../src/lib/payment-payme.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/payment-payme.js')>();
  return {
    ...actual,
    activePaymeCredentials: () => (state.configured
      ? { clientKey: 'CK', baseUrl: state.sandbox ? 'https://sandbox.payme.io/api/' : 'https://live.payme.io/api/' }
      : null),
  };
});

const { GET } = await import('../src/pages/api/payme/hosted-fields.js');

async function ask(slug: string): Promise<{ body: Record<string, unknown>; res: Response }> {
  const res = await GET({ url: new URL(`https://dezabin.co.il/api/payme/hosted-fields?store=${encodeURIComponent(slug)}`) } as never);
  return { body: await res.json() as Record<string, unknown>, res };
}

beforeEach(() => {
  state.configured = true;
  state.sandbox = true;
  state.store = { sellerId: '11111111-1111-4111-8111-111111111111' };
  state.account = { publicKey: 'pk_live_abc', approved: true };
});

describe('when cards can be taken', () => {
  it('hands back the seller\'s PUBLIC key and the environment flag', async () => {
    const { body } = await ask('known');
    expect(body).toEqual({ active: true, publicKey: 'pk_live_abc', testMode: true });
  });

  it('derives testMode from the base URL we configured, not from a separate switch', async () => {
    // So the browser can never be pointed at production while the server talks to staging.
    state.sandbox = false;
    expect((await ask('known')).body.testMode).toBe(false);
  });

  it('never caches — a seller\'s approval changes without warning', async () => {
    expect((await ask('known')).res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('when they cannot — every case is `active: false`, never an error', () => {
  it('an unapproved seller IN PRODUCTION', async () => {
    // Live, his checkout is refused by `merchantBlockFor` anyway, so drawing card fields would
    // collect a card for a purchase that cannot complete.
    state.sandbox = false;
    state.account = { publicKey: 'pk_live_abc', approved: false };
    const { body, res } = await ask('known');
    expect(body).toEqual({ active: false });
    expect(res.status).toBe(200);
  });

  it('but an unapproved seller in the SANDBOX still gets fields — that is what makes the flow testable', async () => {
    // PayMe's sandbox does not model approval: both of our test merchants are `seller_approved:
    // false` and a sale against them completed anyway (measured). Gating the sandbox on approval
    // would block the one thing it exists for — proving the whole flow before launch — while
    // blocking nothing real, since no money moves there. The two halves must agree, so this mirrors
    // `merchantBlockFor` exactly; a card form that appears when the checkout refuses (or the
    // reverse) is a disagreement nobody can see until a buyer hits it.
    state.sandbox = true;
    state.account = { publicKey: 'pk_live_abc', approved: false };
    expect((await ask('known')).body).toEqual({ active: true, publicKey: 'pk_live_abc', testMode: true });
  });

  it('a seller with no merchant account at all', async () => {
    state.account = null;
    expect((await ask('known')).body).toEqual({ active: false });
  });

  it('an approved account that somehow has no public key', async () => {
    // Nothing to initialise the SDK with, so saying "active" would mean a card box that never
    // draws — the exact shape the page hides itself against.
    state.account = { publicKey: '', approved: true };
    expect((await ask('known')).body).toEqual({ active: false });
  });

  it('a store nobody has heard of, and an empty slug', async () => {
    expect((await ask('nope')).body).toEqual({ active: false });
    expect((await ask('')).body).toEqual({ active: false });
  });

  it('no gateway configured — dev, and the window before one exists', async () => {
    state.configured = false;
    const { body, res } = await ask('known');
    expect(body).toEqual({ active: false });
    expect(res.status).toBe(200);
  });
});

describe('what it must never return', () => {
  it('nothing but the three fields — no secret can ride along', async () => {
    // `payme_client_key` and the per-seller `callback_secret` are server-only. This route is
    // reachable by anyone, so the assertion is on the WHOLE shape rather than on the absence of two
    // names: a future field added carelessly fails here rather than shipping.
    const { body } = await ask('known');
    expect(Object.keys(body).sort()).toEqual(['active', 'publicKey', 'testMode']);
  });
});
