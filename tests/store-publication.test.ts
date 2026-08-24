/**
 * When a shop goes on the site, and when it must not.
 *
 * The rule this pins is a product decision (owner, 2026-08-23): a seller builds a whole shop and
 * looks at it before he is ever asked for a card, and only the moment something goes OUT is blocked.
 * Every case here is a way that could go wrong in a way nobody would notice:
 *
 *  · a shop published while its seller cannot take a card — the failure this whole change fixes,
 *    which used to be discovered by a BUYER at the pay button;
 *  · a shop that stays dark after both holds lifted, which is a seller who paid for nothing;
 *  · an unpublished shop readable by a stranger who guessed the URL;
 *  · a live shop taken back off the site by a hold that returned.
 *
 * The subscription and clearing halves are stubbed at their module boundaries — this file is about
 * the GATE. What PayMe actually answer is `payme-adapter.test.ts`'s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  subscribed: true,
  merchantBlock: null as 'no-account' | 'not-approved' | null,
  stores: [] as { id: string; slug: string; sellerId: string; publishedAt?: string; closedAt?: string }[],
  /** Store ids named in the standing order's breakdown. `null` = no subscription row at all. */
  paidStoreIds: null as string[] | null,
  updates: [] as { id: string; patch: Record<string, unknown> }[],
}));

// Both stubs mirror the one rule of the real modules that this file depends on and could not
// otherwise reach: **with no credentials nothing is blocked**. It lives in each of them rather than
// in the gate, so a stub that ignored the argument would quietly turn the last case below into a
// test of the stub.
vi.mock('../src/lib/seller-subscription.js', () => ({
  sellerIsSubscribed: async (_id: string, creds: unknown) => (creds ? state.subscribed : true),
  // What the standing order is actually paying for. Since 2026-08-24 each shop is billed
  // separately, so "this seller is paying" stopped being the whole answer — a second shop must not
  // ride on the first one's fee (`lib/store-plan.ts`).
  subscriptionFor: async () => (state.paidStoreIds === null ? null : { storeFees: state.paidStoreIds.map((id) => ({ storeId: id })) }),
}));
vi.mock('../src/lib/seller-merchant.js', () => ({
  merchantBlockFor: async (_id: string, creds: unknown) => (creds ? state.merchantBlock : null),
}));
vi.mock('../src/lib/db.js', () => ({ rows: async () => [] }));
vi.mock('../src/lib/stores.js', () => ({
  getStoresBySellerId: async (sellerId: string) => state.stores.filter((s) => s.sellerId === sellerId),
  updateStore: async (id: string, patch: Record<string, unknown>) => {
    state.updates.push({ id, patch });
    const store = state.stores.find((s) => s.id === id);
    if (store && typeof patch.publishedAt === 'string') store.publishedAt = patch.publishedAt;
    return store;
  },
}));

const { publishHoldsFor, syncStorePublication, mayPreviewStore } = await import('../src/lib/store-publication.js');

/** Credentials standing in for "a gateway is wired". The gate short-circuits to "nothing is
 *  blocked" without one, which is a separate case asserted at the bottom. */
const CREDS = { clientKey: 'k', baseUrl: 'https://sandbox.payme.io/api/' };

beforeEach(() => {
  state.subscribed = true;
  state.merchantBlock = null;
  state.stores = [{ id: 's1', slug: 'shop', sellerId: 'seller-1' }];
  state.paidStoreIds = ['s1'];
  state.updates = [];
});

describe('publishHoldsFor — what is standing in the way', () => {
  it('reports nothing when the seller is paying and his clearing account is approved', async () => {
    expect(await publishHoldsFor('seller-1', CREDS)).toEqual([]);
  });

  it('separates "he has to fill something in" from "nobody can do anything"', async () => {
    state.merchantBlock = 'no-account';
    expect(await publishHoldsFor('seller-1', CREDS)).toEqual(['clearing-details']);
    state.merchantBlock = 'not-approved';
    expect(await publishHoldsFor('seller-1', CREDS)).toEqual(['clearing-approval']);
  });

  // The whole reason the two are ONE state with two sentences: told separately, a screen could
  // show "waiting for approval" while the seller has not started paying, and he would sit through
  // a week of a wait that was never the thing blocking him.
  /**
   * **The order is the flow, and it was reversed on 2026-08-24.** Paying used to come first, so a
   * seller filled in his details, paid, and then waited up to seven business days for PayMe to
   * approve the business — paying for a shop that was not on the site, through the one week he is
   * most likely to change his mind in (owner: *"אני לא רוצה ליפול בין הכיסאות ושהמוכר יתחרט"*).
   * Clearing first, paying last: the payment is the act that puts the shop up, and it is the last
   * thing between him and that.
   */
  it('reports both holds at once, in the order the seller walks them', async () => {
    state.subscribed = false;
    state.merchantBlock = 'not-approved';
    // Details, then the plan and the card, then the wait nobody can shorten. Everything he can act
    // on comes before the thing he cannot — and since 2026-08-24 none of it charges him until the
    // shop is actually up, which is what lets the card step sit before the review rather than after.
    expect(await publishHoldsFor('seller-1', CREDS)).toEqual(['subscription', 'clearing-approval']);
  });
});

describe('syncStorePublication', () => {
  it('publishes a waiting shop once both holds are clear', async () => {
    const published = await syncStorePublication('seller-1', CREDS);
    expect(published).toEqual(['shop']);
    expect(typeof state.updates[0]!.patch.publishedAt).toBe('string');
  });

  // The failure this whole change exists to fix: a shop on the site whose seller has nowhere for a
  // buyer's money to go. It used to be found at the pay button, after an address had been typed.
  it('refuses to publish while the seller cannot take a card', async () => {
    state.merchantBlock = 'not-approved';
    expect(await syncStorePublication('seller-1', CREDS)).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('refuses to publish a seller who has not started paying', async () => {
    state.subscribed = false;
    expect(await syncStorePublication('seller-1', CREDS)).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  /**
   * **A second shop must not ride on the first one's fee** (owner, 2026-08-24: *"כל חנות צריכה
   * לעלות כסף בנפרד"*). This is the failure mode that would have been silent rather than visible:
   * the account-level hold is clear because he IS paying, so a shop he never added to the standing
   * order would have gone live for nothing and no screen would have said anything.
   */
  it('publishes only the shops the standing order actually pays for', async () => {
    state.stores = [
      { id: 's1', slug: 'paid-for', sellerId: 'seller-1' },
      { id: 's2', slug: 'not-paid-for', sellerId: 'seller-1' },
    ];
    state.paidStoreIds = ['s1'];
    expect(await syncStorePublication('seller-1', CREDS)).toEqual(['paid-for']);
    expect(state.updates.map((u) => u.id)).toEqual(['s1']);
  });

  // PayMe may deliver the same notification twice, and the sweep runs on a timer beside it. A
  // second publication would move the date a store went live, which is a fact about the past.
  it('is idempotent — a second run publishes nothing and touches no row', async () => {
    await syncStorePublication('seller-1', CREDS);
    state.updates = [];
    expect(await syncStorePublication('seller-1', CREDS)).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  // Only ever publishes. Taking a live shop off the site is pause/close/block, each with a seller
  // notified and open orders honoured — none of which belongs inside a payment callback.
  it('never un-publishes a live shop when a hold comes back', async () => {
    state.stores = [{ id: 's1', slug: 'shop', sellerId: 'seller-1', publishedAt: '2026-01-01T00:00:00.000Z' }];
    state.subscribed = false;
    state.merchantBlock = 'not-approved';
    await syncStorePublication('seller-1', CREDS);
    expect(state.updates).toEqual([]);
    expect(state.stores[0]!.publishedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it("publishes every one of the seller's waiting shops that the standing order pays for", async () => {
    state.stores = [
      { id: 's1', slug: 'one', sellerId: 'seller-1' },
      { id: 's2', slug: 'two', sellerId: 'seller-1' },
      { id: 's3', slug: 'other', sellerId: 'seller-9' },
    ];
    state.paidStoreIds = ['s1', 's2'];
    expect(await syncStorePublication('seller-1', CREDS)).toEqual(['one', 'two']);
    expect(state.updates.map((u) => u.id)).toEqual(['s1', 's2']);
  });

  // With no gateway nobody could clear or subscribe, so a hold would take the whole platform dark
  // in development. `site-mode.ts` is what stops a production server selling without a provider.
  it('publishes freely when no clearing provider is configured at all', async () => {
    state.subscribed = false;
    state.merchantBlock = 'no-account';
    expect(await publishHoldsFor('seller-1', null)).toEqual([]);
    expect(await syncStorePublication('seller-1', null)).toEqual(['shop']);
  });
});

describe('mayPreviewStore — the one exception to the 404', () => {
  const waiting = { sellerId: 'seller-1' };

  it('lets the owner see his own unpublished shop', () => {
    expect(mayPreviewStore(waiting, 'seller-1')).toBe(true);
  });

  // The session cookie is the only thing in front of an unpublished shop, so the two ways past it
  // are asserted rather than assumed: another signed-in seller, and nobody at all.
  it('shows it to nobody else, signed in or not', () => {
    expect(mayPreviewStore(waiting, 'seller-2')).toBe(false);
    expect(mayPreviewStore(waiting, null)).toBe(false);
  });

  // It is a preview of the UNPUBLISHED state and nothing else: a blocked or closed store must keep
  // answering 404/410 to its owner too, or an admin block becomes a suggestion.
  it('does not reopen a store that was closed or blocked', () => {
    const live = { sellerId: 'seller-1', publishedAt: '2026-01-01T00:00:00.000Z' };
    expect(mayPreviewStore({ ...live, closedAt: '2026-02-01T00:00:00.000Z' }, 'seller-1')).toBe(false);
    expect(mayPreviewStore({ ...live, blocked: true }, 'seller-1')).toBe(false);
    expect(mayPreviewStore({ ...waiting, blocked: true }, 'seller-1')).toBe(false);
  });
});
