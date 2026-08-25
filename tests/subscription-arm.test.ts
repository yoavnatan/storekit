/**
 * A card held through the review, charged when the shop goes up.
 *
 * The change of 2026-08-24 answers two of the owner's objections with one mechanism, and each of
 * them is a way this can fail silently:
 *
 *  · **charging too early** — the whole point is that PayMe's seven-day review costs the seller
 *    nothing, so arming a card must reach their API with nothing at all. A `generate-subscription`
 *    slipping into this path charges immediately (measured: `sub_paid: true`) and nobody would
 *    notice until a card statement;
 *  · **charging on an approval that is not there** — the charge happens with no human present, so
 *    the clearing gate has to be re-asked at the moment of spending rather than trusted from
 *    whenever the sweep last looked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rig = vi.hoisted(() => ({
  /** The row in `seller_subscriptions`, or null. */
  row: null as Record<string, unknown> | null,
  /** Shops on the site, as `store-plan.ts` would answer. */
  stores: [] as { storeId: string; storeName: string; tier: string; feeAgorot: number }[],
  /** What `merchantBlockFor` says: null = approved and able to sell. */
  merchantBlock: null as string | null,
  /** Every call that actually reached PayMe. Empty is the assertion in the arming case. */
  generated: [] as Record<string, unknown>[],
  published: [] as string[],
  errors: [] as Record<string, unknown>[],
  queries: [] as { sql: string; params: readonly unknown[] }[],
  /** How many times a clearing account was asked for. Zero everywhere except arming. */
  opened: 0,
}));

vi.mock('../src/lib/db.js', () => ({
  isUuid: () => true,
  firstRow: async (sql: string, params: readonly unknown[]) => {
    rig.queries.push({ sql, params });
    // The one read in the codebase that selects the card token — see `subscription-arm.ts`.
    if (sql.includes('SELECT buyer_key')) {
      return rig.row && !rig.row['provider_ref'] && rig.row['card_saved_at'] ? { buyer_key: rig.row['buyer_key'] } : null;
    }
    if (sql.includes('INSERT INTO seller_subscriptions')) {
      rig.row = {
        seller_id: params[0], provider: 'payme', provider_ref: params[1], store_fees: params[2],
        price_agorot: params[3], status: params[4], started_at: null, next_charge: params[6],
        canceled_at: null, ends_at: null, card_saved_at: null, buyer_key: params[5],
      };
      return rig.row;
    }
    return rig.row;
  },
  query: async (sql: string, params: readonly unknown[]) => {
    rig.queries.push({ sql, params });
    if (sql.includes('INSERT INTO seller_subscriptions')) {
      rig.row = {
        seller_id: params[0], provider: 'payme', provider_ref: null, store_fees: params[1],
        price_agorot: params[2], status: null, started_at: null, next_charge: null,
        canceled_at: null, ends_at: null, card_saved_at: '2026-08-24T00:00:00.000Z', buyer_key: params[3],
      };
    }
  },
}));
vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerById: async () => ({ id: 'seller-1', name: 'חנות הבדיקה', email: 's@example.com' }),
}));
vi.mock('../src/lib/store-plan.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/store-plan.js')>('../src/lib/store-plan.js');
  return { ...actual, billedStoresFor: async () => rig.stores };
});
vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantBlockFor: async () => rig.merchantBlock,
  // Arming a card is what OPENS the clearing account since 2026-08-25 — every account costs ₪65 a
  // month for ever and cannot be closed at PayMe, so it waits for the seller to commit. Recorded
  // rather than performed: what it sends is `seller-merchant.ts`'s to test.
  ensureMerchantAccount: async () => { rig.opened += 1; return { status: 'pending' }; },
}));
vi.mock('../src/lib/stores.js', () => ({
  getStoresBySellerId: async () => [{ id: 'store-1', slug: 'shop', name: 'החנות', description: '', tagline: '' }],
}));
vi.mock('../src/lib/store-publication.js', () => ({ syncStorePublication: async () => rig.published }));
vi.mock('../src/lib/money-events.js', () => ({ recordMoneyEvent: async () => undefined }));
vi.mock('../src/lib/error-log.js', () => ({
  logError: async (e: Record<string, unknown>) => { rig.errors.push(e); },
}));

const CREDS = { clientKey: 'k', ownMerchantId: 'MPL-OURS', ownPublicKey: 'pk', baseUrl: 'https://sandbox.payme.io/api/' };
vi.mock('../src/lib/payment-payme.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/payment-payme.js')>('../src/lib/payment-payme.js');
  return {
    ...actual,
    activePaymeCredentials: () => CREDS,
    generateSubscription: async (input: Record<string, unknown>) => {
      rig.generated.push(input);
      return { subPaymeId: 'SUB1', subStatus: actual.PAYME_SUB_STATUS.active, nextDate: '2026-09-24 10:00:00' };
    },
    getSubscriptionStatus: async () => null,
  };
});

const { armSubscriptionCard, startArmedSubscription } = await import('../src/lib/subscription-arm.js');
const { sellerIsSubscribed, subscriptionFor } = await import('../src/lib/seller-subscription.js');

beforeEach(() => {
  rig.row = null;
  rig.stores = [{ storeId: 'store-1', storeName: 'החנות', tier: 'starter', feeAgorot: 9900 }];
  rig.merchantBlock = 'not-approved';
  rig.generated = [];
  rig.published = ['shop'];
  rig.errors = [];
  rig.queries = [];
  rig.opened = 0;
});

describe('putting a card on file', () => {
  /** **The assertion this file exists for.** */
  it('reaches PayMe with nothing at all', async () => {
    const res = await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    expect(res).toEqual({ status: 'armed', priceAgorot: 9900 });
    // A `generate-subscription` here would charge the first iteration on the spot, which is exactly
    // the review week this whole change exists to stop charging for.
    expect(rig.generated).toEqual([]);
  });

  /**
   * **The ₪65-a-month decision, as an assertion** (owner, 2026-08-25). Every clearing account is
   * charged to our partner wallet for as long as it exists, it cannot be deactivated or deleted at
   * PayMe, and it cannot be billed to the seller. Opening it when a FORM was submitted meant paying
   * that for everyone who ever changed their mind; it opens here, where he has committed.
   */
  it('opens the clearing account HERE, at the moment he commits', async () => {
    await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    expect(rig.opened).toBe(1);
  });

  it('opens nothing for a seller with no shop to bill — there is no commitment to price', async () => {
    rig.stores = [];
    await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    expect(rig.opened).toBe(0);
  });

  it('records what the card will be charged, so it can be shown before it happens', async () => {
    rig.stores = [
      { storeId: 'a', storeName: 'א', tier: 'growth', feeAgorot: 12500 },
      { storeId: 'b', storeName: 'ב', tier: 'starter', feeAgorot: 9900 },
    ];
    const res = await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    expect(res).toMatchObject({ status: 'armed', priceAgorot: 22400 });
    expect((await subscriptionFor('seller-1'))?.priceAgorot).toBe(22400);
  });

  // He is committed, not paying. Anything that reads this as "paying" would put his shop on the
  // site before a shekel moved — the failure the publication gate exists to prevent.
  it('does NOT count as being subscribed', async () => {
    await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    expect(await sellerIsSubscribed('seller-1', CREDS)).toBe(false);
    expect((await subscriptionFor('seller-1'))?.status).toBeNull();
  });

  it('refuses to replace a card PayMe are already charging', async () => {
    rig.row = { seller_id: 'seller-1', provider: 'payme', provider_ref: 'SUB1', store_fees: [], price_agorot: 9900, status: 2, started_at: null, next_charge: null, canceled_at: null, ends_at: null, card_saved_at: null };
    expect(await armSubscriptionCard('seller-1', 'TOKEN-2', {}, CREDS)).toEqual({ status: 'already' });
  });

  it('names no amount for a seller with no shop ready', async () => {
    rig.stores = [];
    expect(await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS)).toEqual({ status: 'no-store-to-bill' });
  });
});

describe('the approval landing', () => {
  it('waits while the processor has not approved him', async () => {
    await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    expect(await startArmedSubscription('seller-1', CREDS)).toEqual([]);
    expect(rig.generated).toEqual([]);
  });

  /** The moment the wait ends — and the seller is not present for it, which is the point. */
  it('charges the card and puts the shop up, with nobody pressing anything', async () => {
    await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    rig.merchantBlock = null;

    expect(await startArmedSubscription('seller-1', CREDS)).toEqual(['shop']);
    expect(rig.generated).toHaveLength(1);
    // The stored token, not one from a request — the seller has been gone for a week.
    expect(rig.generated[0]).toMatchObject({ buyerKey: 'TOKEN-1', priceAgorot: 9900 });
  });

  it('does nothing for a seller who never put a card on file', async () => {
    rig.merchantBlock = null;
    expect(await startArmedSubscription('seller-1', CREDS)).toEqual([]);
    expect(rig.generated).toEqual([]);
  });

  it('is idempotent — a second sweep does not charge again', async () => {
    await armSubscriptionCard('seller-1', 'TOKEN-1', {}, CREDS);
    rig.merchantBlock = null;
    await startArmedSubscription('seller-1', CREDS);
    rig.generated = [];
    // The row now carries a `provider_ref`, so it is no longer armed and this path is closed to it.
    expect(await startArmedSubscription('seller-1', CREDS)).toEqual([]);
    expect(rig.generated).toEqual([]);
  });
});
