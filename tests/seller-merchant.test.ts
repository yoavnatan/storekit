/**
 * The seller's clearing account — the row that decides whether his shops may sell, and the two
 * things about it that were built without a test of their own.
 *
 *  · **`merchantBlockFor` is the selling gate.** It runs in `/api/checkout`'s pre-pass, before a
 *    unit of stock moves, and its two exceptions are both deliberate and both easy to lose in a
 *    later edit: it answers `null` when PayMe are unconfigured (or every shop on the platform goes
 *    dark in development), and it ignores approval in the SANDBOX (or the one environment that
 *    exists to prove the flow before launch cannot prove it).
 *  · **`setMerchantApproval` announces.** The seller has been waiting up to seven business days on
 *    a decision he cannot influence, so the moment it lands is news — and it arrives on a callback
 *    PayMe may deliver twice, with a sweep running beside it. Announcing the same approval twice is
 *    the failure the conditional write exists to prevent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  /** `approved` on the stored row, or null when the seller has no account at all. */
  approved: null as boolean | null,
  notifications: [] as Record<string, unknown>[],
  /** Every UPDATE the module ran, so the "changed rows only" rule can be asserted on the SQL. */
  updates: [] as { sql: string; params: readonly unknown[] }[],
}));

vi.mock('../src/lib/db.js', () => ({
  isUuid: () => true,
  firstRow: async () => (rig.approved === null
    ? null
    : { seller_id: 'seller-1', provider: 'payme', provider_ref: 'MPL-1', public_key: 'pk', signup_link: 'https://x/y', approved: rig.approved, created_at: null }),
  rows: async (sql: string, params: readonly unknown[]) => {
    rig.updates.push({ sql, params });
    if (!sql.includes('UPDATE seller_merchant_accounts')) return [];
    // The real statement's `approved IS DISTINCT FROM $2` — no row comes back when nothing moved,
    // and that emptiness is the whole de-duplication.
    const next = params[1] as boolean;
    if (rig.approved === next) return [];
    rig.approved = next;
    return [{ seller_id: 'seller-1' }];
  },
  query: async () => {},
}));
vi.mock('../src/lib/notifications.js', () => ({
  createNotification: async (n: Record<string, unknown>) => { rig.notifications.push(n); return n; },
}));
vi.mock('../src/lib/stores.js', () => ({ getStoresBySellerId: async () => [] }));
vi.mock('../src/lib/seller-auth.js', () => ({ getSellerById: async () => null }));
vi.mock('../src/lib/error-log.js', () => ({ logError: async () => {} }));

const { merchantBlockFor, setMerchantApproval, clearingStatusFor, safeMerchantLink } =
  await import('../src/lib/seller-merchant.js');

const SANDBOX = { clientKey: 'k', baseUrl: 'https://sandbox.payme.io/api/' };
const LIVE = { clientKey: 'k', baseUrl: 'https://live.payme.io/api/' };

beforeEach(() => {
  rig.approved = null;
  rig.notifications = [];
  rig.updates = [];
});

describe('merchantBlockFor — the gate in front of every sale', () => {
  it('refuses a seller with no account at all', async () => {
    expect(await merchantBlockFor('seller-1', LIVE)).toBe('no-account');
  });

  // Live, PayMe examine every business and may refuse one at their sole discretion (agreement §11).
  // A `Restricted` merchant's charge is refused in front of a buyer mid-checkout; refusing earlier,
  // with a sentence the seller can act on, is the whole point of the gate.
  it('refuses an unapproved account in production', async () => {
    rig.approved = false;
    expect(await merchantBlockFor('seller-1', LIVE)).toBe('not-approved');
    rig.approved = true;
    expect(await merchantBlockFor('seller-1', LIVE)).toBeNull();
  });

  // **The sandbox does not model approval** — both test merchants sit `seller_approved: false` and a
  // `generate-sale` against them completes anyway (`docs/payme-sandbox-notes.md` §2). Gating on it
  // there blocks the one thing the sandbox is for, while blocking nothing real, since it moves no
  // money.
  it('ignores approval in the sandbox, which is the only place the flow can be proved', async () => {
    rig.approved = false;
    expect(await merchantBlockFor('seller-1', SANDBOX)).toBeNull();
  });

  // With no gateway there is no clearing account for anyone, so gating on one would close every
  // store in development and through the pre-gateway window. `site-mode.ts` guards THAT window, by
  // refusing to sell at all on a production server whose provider cannot take money.
  it('blocks nothing when PayMe are not configured', async () => {
    expect(await merchantBlockFor('seller-1', null)).toBeNull();
  });
});

describe('setMerchantApproval — the end of a week-long wait', () => {
  it('announces an approval once', async () => {
    rig.approved = false;
    await setMerchantApproval('MPL-1', true);
    expect(rig.notifications).toHaveLength(1);
    expect(rig.notifications[0]).toMatchObject({ userId: 'seller-1', role: 'seller', type: 'merchant_approved' });
  });

  // PayMe may deliver the same callback twice and the publication sweep re-reads beside it. The
  // statement is conditional on the value CHANGING, so the second one writes nothing and says
  // nothing — a read-then-write here would announce twice under exactly the concurrency it has to
  // survive.
  it('says nothing the second time the same approval arrives', async () => {
    rig.approved = false;
    await setMerchantApproval('MPL-1', true);
    await setMerchantApproval('MPL-1', true);
    await setMerchantApproval('MPL-1', true);
    expect(rig.notifications).toHaveLength(1);
    expect(rig.updates.filter((u) => u.sql.includes('UPDATE'))).toHaveLength(3);
    expect(rig.updates[0]!.sql).toContain('IS DISTINCT FROM');
  });

  // Losing an approval is a real event and worth recording, but it is not news anybody wants
  // announced as though it were good — and there is no copy for it. Silence, deliberately.
  it('records a withdrawal without announcing one', async () => {
    rig.approved = true;
    await setMerchantApproval('MPL-1', false);
    expect(rig.approved).toBe(false);
    expect(rig.notifications).toEqual([]);
  });
});

describe('what the seller is TOLD about his account', () => {
  it('says nothing at all when no clearing provider is configured', async () => {
    expect(await clearingStatusFor('seller-1', null)).toBeNull();
  });

  it('asks for details when there is no account, and waits when there is an unapproved one', async () => {
    expect(await clearingStatusFor('seller-1', LIVE)).toMatchObject({ state: 'missing-details' });
    rig.approved = false;
    expect(await clearingStatusFor('seller-1', LIVE)).toMatchObject({ state: 'awaiting-approval', signupLink: 'https://x/y' });
    rig.approved = true;
    expect(await clearingStatusFor('seller-1', LIVE)).toMatchObject({ state: 'ready' });
  });

  // The same rule `merchantBlockFor` applies, and it has to be the same one: this sentence is what a
  // seller reads to find out whether his shop can sell, so a screen saying "waiting for approval"
  // while the checkout happily takes orders would be the worse half of a disagreement nobody sees.
  it('agrees with the gate in the sandbox rather than contradicting it', async () => {
    rig.approved = false;
    expect(await merchantBlockFor('seller-1', SANDBOX)).toBeNull();
    expect(await clearingStatusFor('seller-1', SANDBOX)).toMatchObject({ state: 'ready' });
  });
});

describe('the signup link reaches an href, so it is shaped before it gets there', () => {
  // It comes from PayMe rather than from a request, which is why this is defence in depth — but
  // "the value came from our provider" is an assumption, not a check, and a `javascript:` string in
  // an href is script execution.
  it('passes https and refuses everything else', () => {
    expect(safeMerchantLink('https://newpartners.payme.io/update-details?t=x')).toContain('https://');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'http://x/y', 'data:text/html,x', '', null, undefined, 'not a url']) {
      expect(safeMerchantLink(bad as string), String(bad)).toBeNull();
    }
  });
});
