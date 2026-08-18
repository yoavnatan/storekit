/**
 * **An order that gets CHEAPER after it was paid owes the buyer the difference.**
 *
 * The gap this covers was found by asking one question about a feature that looked correct: the
 * seller's order screen can delete a line, override shipping and set a discount on an order whose
 * card has already been charged, and the arithmetic was right every time — 200 goods less a 20%
 * discount plus 30 shipping really is 190. What nothing did was notice that the buyer had paid 230.
 *
 * It survived because it falls between two well-built pieces. `refund-owed.ts` asks whether an
 * order LEFT the sales, which a partial reduction never does; `api/seller/orders.ts` asks whether
 * the SELLER's net moved, which is a different question with a different answer. Neither was wrong,
 * and the money was owed to nobody.
 *
 * Every case below is one way that seam reopens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Order } from '../src/lib/orders.js';

const journal = vi.hoisted(() => ({ events: [] as Record<string, unknown>[], adjustments: [] as Record<string, unknown>[] }));

vi.mock('../src/lib/money-events.js', () => ({
  recordMoneyEvent: async (e: Record<string, unknown>) => { journal.events.push(e); },
}));
vi.mock('../src/lib/payouts.js', () => ({
  recordAdjustment: async (a: Record<string, unknown>) => { journal.adjustments.push(a); },
}));
vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerById: async () => ({ id: 'seller-1', tier: 'starter' }),
}));

const hold = vi.hoisted(() => ({ state: 'releasable' as string }));
vi.mock('../src/lib/payout-hold.js', () => ({ orderHold: () => ({ state: hold.state }) }));

const {
  partialRefundOwedAgorot, recordPartialRefundOwed, recordPartialSellerClawback,
} = await import('../src/lib/refund-owed.js');

/** A paid, in-progress order for one store. 200 goods + 30 shipping. */
function order(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-11111111-2222-3333-4444-555555555555',
    checkoutRef: 'CHK-1',
    buyerName: 'קונה', buyerEmail: 'b@example.com', buyerPhone: '050', buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ productId: 'p1', productName: 'פריט', productSlug: 'p1', storeSlug: 'shop', storeName: 'חנות', priceAgorot: 20000, qty: 1, image: '' }],
    storeSubtotals: { shop: { subtotalAgorot: 20000, shippingAgorot: 3000, storeName: 'חנות' } },
    shippingAgorot: 3000,
    totalAgorot: 23000,
    paymentRef: 'HYP-1',
    paymentStatus: 'paid',
    shippingStatus: 'pending',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...over,
  } as unknown as Order;
}

beforeEach(() => { journal.events = []; journal.adjustments = []; hold.state = 'releasable'; });

describe('what the buyer is owed', () => {
  it('is the drop in the total — what left the card and bought nothing', () => {
    // A 20% discount on 200 of goods. The buyer paid 230 and the order is now 190.
    expect(partialRefundOwedAgorot(order(), order({ totalAgorot: 19000 }))).toBe(4000);
  });

  it('is NOT the drop in the seller\'s share', () => {
    // Commission and shipping are our arrangement with the seller and the carrier. The buyer is
    // party to neither, and is owed the whole difference.
    const owed = partialRefundOwedAgorot(order(), order({ totalAgorot: 19000 }));
    expect(owed).toBe(23000 - 19000);
  });

  it('is nothing when the order got MORE expensive', () => {
    // We cannot charge a card again off the back of an edit, so a positive obligation here would be
    // a journal row nothing could ever settle.
    expect(partialRefundOwedAgorot(order(), order({ totalAgorot: 25000 }))).toBe(0);
  });

  it('is nothing on an order that was never charged', () => {
    const before = order({ paymentStatus: 'pending' });
    expect(partialRefundOwedAgorot(before, order({ paymentStatus: 'pending', totalAgorot: 19000 }))).toBe(0);
  });

  it('is nothing once the order has LEFT the sales — that is the whole-order rule\'s job', () => {
    // Both firing would record the reduction twice: once as a partial refund and once as the
    // whole slice.
    expect(partialRefundOwedAgorot(order(), order({ totalAgorot: 19000, shippingStatus: 'cancelled' }))).toBe(0);
  });
});

describe('the obligation that gets written', () => {
  it('names the buyer\'s money, the reference, and the subtraction that produced it', async () => {
    const owed = await recordPartialRefundOwed(order(), order({ totalAgorot: 19000 }), 'shop', 'seller-1');
    expect(owed).toBe(4000);
    const due = journal.events.find((e) => e.type === 'refund_due');
    expect(due, 'no refund_due was written').toBeTruthy();
    expect(due!.amountAgorot).toBe(4000);
    expect(due!.from).toBe('23000');
    expect(due!.to).toBe('19000');
    // Read months later by someone reconciling, and that reader reads Hebrew.
    expect(String(due!.detail)).toMatch(/מגיע בחזרה לקונה/);
    expect(String(due!.detail)).toContain('HYP-1');
  });

  it('writes nothing at all when the edit owed nothing', async () => {
    expect(await recordPartialRefundOwed(order(), order({ totalAgorot: 23000 }), 'shop', 'seller-1')).toBe(0);
    expect(journal.events).toEqual([]);
  });

  it('records the buyer side even with no seller in hand', async () => {
    // The buyer-side obligation must never depend on the clawback being available.
    await recordPartialRefundOwed(order(), order({ totalAgorot: 19000 }), 'shop', 'system');
    expect(journal.events.filter((e) => e.type === 'refund_due')).toHaveLength(1);
    expect(journal.adjustments).toEqual([]);
  });
});

describe('the seller\'s side', () => {
  it('debits only the DROP in their share, not their whole net', async () => {
    // The sale still stands for the reduced amount — this is the one way it differs from a
    // cancellation, which claws back everything.
    const drop = await recordPartialSellerClawback(order(), order({ totalAgorot: 19000, storeSubtotals: { shop: { subtotalAgorot: 16000, shippingAgorot: 3000, storeName: 'חנות' } } } as Partial<Order>), 'shop', 'seller-1');
    expect(drop).toBeGreaterThan(0);
    expect(journal.adjustments).toHaveLength(1);
    expect(journal.adjustments[0]!.amountAgorot).toBe(-drop);
  });

  it('does nothing while the money is still HELD', async () => {
    // Nothing left, so the balance arithmetic corrects itself the moment the total changes.
    hold.state = 'held';
    expect(await recordPartialSellerClawback(order(), order({ totalAgorot: 19000 }), 'shop', 'seller-1')).toBe(0);
    expect(journal.adjustments).toEqual([]);
  });

  it('uses its OWN kind, so a second edit is not swallowed by the first', async () => {
    // `refund_clawback` is idempotent on (order, kind) because a cancellation happens once. An
    // order can be edited many times and each reduction is its own debit.
    await recordPartialSellerClawback(order(), order({ totalAgorot: 19000, storeSubtotals: { shop: { subtotalAgorot: 16000, shippingAgorot: 3000, storeName: 'חנות' } } } as Partial<Order>), 'shop', 'seller-1');
    expect(journal.adjustments[0]!.kind).toBe('refund_clawback_partial');
    expect(journal.adjustments[0]!.kind).not.toBe('refund_clawback');
  });
});

describe('the route that edits an order calls it', () => {
  it('is wired into api/seller/orders.ts, before the seller-side note', async () => {
    // The seam itself, pinned: the arithmetic living in refund-owed.ts is worth nothing if the one
    // route that can lower a paid order never asks it. Order matters — if only one of the two
    // journal writes lands, the one naming real money owed to a real person is the one to keep.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/pages/api/seller/orders.ts', 'utf8'));
    expect(src).toMatch(/recordPartialRefundOwed\(/);
    expect(src.indexOf('recordPartialRefundOwed(')).toBeLessThan(src.indexOf("type: 'order_discount_changed'"));
  });
});

describe('the buyer is TOLD, not only owed', () => {
  it('names the amount rather than saying the order changed', async () => {
    // A card statement does not change retroactively. "Your order was updated" leaves the buyer
    // comparing a 230 charge against a 190 order with nothing explaining the gap.
    const { buildOrderCheapenedNotification } = await import('../src/lib/order-notify.js');
    const n = buildOrderCheapenedNotification(order({ buyerId: 'buyer-1' } as Partial<Order>), 4000, { storeName: 'חנות' });
    expect(n, 'no notification was built').toBeTruthy();
    expect(n!.body).toContain('40');
    expect(String(n!.body)).toMatch(/יוחזר/);
  });

  it('builds nothing for a guest — the email is their channel', async () => {
    const { buildOrderCheapenedNotification } = await import('../src/lib/order-notify.js');
    expect(buildOrderCheapenedNotification(order(), 4000)).toBeNull();
  });

  it('builds nothing when the edit owed nothing', async () => {
    const { buildOrderCheapenedNotification } = await import('../src/lib/order-notify.js');
    expect(buildOrderCheapenedNotification(order({ buyerId: 'buyer-1' } as Partial<Order>), 0)).toBeNull();
  });

  it('emails everyone, including the guests who are most of them, with the amount', async () => {
    const { buildOrderCheapenedEmail } = await import('../src/lib/email/order-status-email.js');
    const mail = buildOrderCheapenedEmail(order(), 4000);
    expect(mail, 'no email was built').toBeTruthy();
    expect(mail!.to).toBe('b@example.com');
    expect(mail!.html).toContain('40');
    expect(mail!.text).toMatch(/יוחזר/);
  });

  it('carries the warning about wiring a real gateway where the promise is made', async () => {
    // The owner asked for it to live beside the message, not in a checklist: this mail promises
    // money back, and today nothing settles the obligation behind it.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/lib/email/order-status-email.ts', 'utf8'));
    expect(src).toMatch(/⚠️[\s\S]{0,400}gateway is wired/);
  });

  it('is called by the route, and only when something is owed', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/pages/api/seller/orders.ts', 'utf8'));
    expect(src).toMatch(/notifyOrderCheapened\(/);
    expect(src).toMatch(/if \(owedToBuyer > 0\)/);
  });
});
