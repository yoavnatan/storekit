/**
 * A buyer's bank took the money back — the rules of what we do about it.
 *
 * The defect this covers was SILENCE, so most of these assert that something is said. Before
 * 2026-08-25 a `sale-chargeback` was journalled as `payment_attempted` and nothing else happened:
 * the wrong type on the row, no notification, and a seller who would learn about it from his bank.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ events: [] as any[], notes: [] as any[], logs: [] as any[], orders: [] as any[], store: null as any }));

vi.mock('../src/lib/db.js', () => ({
  rows: async () => calls.orders,
}));
vi.mock('../src/lib/money-events.js', () => ({
  recordMoneyEvent: async (e: unknown) => { calls.events.push(e); },
}));
vi.mock('../src/lib/notifications.js', () => ({
  createNotification: async (n: unknown) => { calls.notes.push(n); return n; },
}));
vi.mock('../src/lib/stores.js', () => ({
  getStoreBySlug: async () => calls.store,
}));
vi.mock('../src/lib/error-log.js', () => ({
  logError: async (e: unknown) => { calls.logs.push(e); },
}));

const { recordChargeback, splitTransactionId } = await import('../src/lib/payme-chargeback.js');

beforeEach(() => {
  calls.events = []; calls.notes = []; calls.logs = [];
  calls.orders = [{ id: 'ORD-1', seller_id: 'SELLER-1', store_slug: 'bag-boutique', total_agorot: 12000 }];
  calls.store = { slug: 'bag-boutique', sellerId: 'SELLER-1' };
});

describe('splitTransactionId', () => {
  /** The whole reason this is a function: a slug may contain dashes and `checkoutRef` may not, so
   *  splitting on the LAST dash returns `boutique` and matches no store. */
  it('splits on the FIRST dash, so a hyphenated slug survives', () => {
    expect(splitTransactionId('03BE8146-bag-boutique')).toEqual({ checkoutRef: '03BE8146', leg: 'bag-boutique' });
  });

  it('reads the delivery leg', () => {
    expect(splitTransactionId('03BE8146-delivery')).toEqual({ checkoutRef: '03BE8146', leg: 'delivery' });
  });

  it('refuses a reference with no two halves rather than inventing one', () => {
    for (const bad of ['', 'no-dash-at-start'.slice(0, 0), '03BE8146', '-leading', 'trailing-']) {
      expect(splitTransactionId(bad), bad).toBeNull();
    }
  });
});

describe('recordChargeback', () => {
  it('journals it under its OWN type, never as a payment attempt', async () => {
    await recordChargeback({ transactionId: '03BE8146-bag-boutique', paymeSaleId: 'SALE-9', amountAgorot: 12000, kind: 'chargeback' });
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toMatchObject({ type: 'chargeback', orderId: 'ORD-1', storeSlug: 'bag-boutique', amountAgorot: 12000 });
  });

  it('tells the SELLER, against the order, so the money is not news from his bank', async () => {
    await recordChargeback({ transactionId: '03BE8146-bag-boutique', paymeSaleId: 'SALE-9', amountAgorot: 12000, kind: 'chargeback' });
    expect(calls.notes).toHaveLength(1);
    expect(calls.notes[0]).toMatchObject({ userId: 'SELLER-1', role: 'seller', relatedId: 'ORD-1' });
    expect(calls.notes[0].body).toContain('120');
  });

  it('uses different words when the bank finds for the seller', async () => {
    await recordChargeback({ transactionId: '03BE8146-bag-boutique', paymeSaleId: 'SALE-9', amountAgorot: 12000, kind: 'chargeback_reverted' });
    expect(calls.events[0]).toMatchObject({ type: 'chargeback_reverted' });
    expect(calls.notes[0].title).not.toContain('הכחיש');
  });

  /** The delivery charge is against OUR merchant account for the whole cart and belongs to no order
   *  row (`payment-split.ts`). It must still be recorded — and it must not be attached to whichever
   *  order happens to share the checkout. */
  it('records a delivery-leg dispute with no order attached', async () => {
    await recordChargeback({ transactionId: '03BE8146-delivery', paymeSaleId: 'SALE-9', amountAgorot: 3000, kind: 'chargeback' });
    expect(calls.events[0].orderId).toBeUndefined();
    expect(calls.notes).toHaveLength(0);
    expect(calls.logs[0].message).toContain('NO MATCHING ORDER');
  });

  /** The sandbox is shared with PayMe's other partners, so a callback naming a checkout that was
   *  never ours is an ordinary event — and still one somebody should be able to see. */
  it('is loud rather than silent when it cannot identify the sale', async () => {
    calls.orders = [];
    await recordChargeback({ transactionId: '03BE8146-bag-boutique', paymeSaleId: 'SALE-9', amountAgorot: 12000, kind: 'chargeback' });
    expect(calls.events).toHaveLength(1);
    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0].message).toContain('NO MATCHING ORDER');
  });

  it('logs even on the happy path — nothing here happens automatically, so a person has to see it', async () => {
    await recordChargeback({ transactionId: '03BE8146-bag-boutique', paymeSaleId: 'SALE-9', amountAgorot: 12000, kind: 'chargeback' });
    expect(calls.logs).toHaveLength(1);
    expect(calls.logs[0].message).toContain('ORD-1');
  });

  /** It runs inside a webhook that must answer 200 or PayMe retry it, so no failure below may
   *  escape — and losing one of the two records must not lose the other. */
  it('never throws when the journal or the notification fails', async () => {
    const events = await import('../src/lib/money-events.js');
    vi.spyOn(events, 'recordMoneyEvent').mockRejectedValueOnce(new Error('db down'));
    await expect(recordChargeback({ transactionId: '03BE8146-bag-boutique', paymeSaleId: 'S', amountAgorot: 1, kind: 'chargeback' })).resolves.toMatchObject({ orderId: 'ORD-1' });
    expect(calls.notes).toHaveLength(1);
  });
});
