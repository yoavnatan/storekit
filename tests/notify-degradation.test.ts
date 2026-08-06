/**
 * **A message that could not be delivered never un-does what it was announcing.**
 *
 * An order is committed, a charge has happened, stock has moved. Everything after that — the
 * buyer's in-app badge, the buyer's email, the seller's email — is an ANNOUNCEMENT, and an
 * announcement that fails is a smaller problem than the announcement being allowed to reverse the
 * fact. This file drives the failures: a mail provider that is down, a mail provider that HANGS, a
 * notifications table that rejects the insert.
 *
 * `order-notify.test.ts` covers what a correct notification says. Nothing there fails on purpose,
 * which is why none of its assertions would have caught the ordering bug this file exists beside:
 * `notifyOrderStatusChanged` was awaited UNGUARDED between the restock and `settleStoreClosure`, so
 * a throw would have 500'd a status change that had already succeeded and silently skipped the
 * closure a seller was waiting on — with nothing to retry, because that status change never fires
 * twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '../src/lib/orders.js';

const createNotification = vi.fn();
const sendOrderStatusEmail = vi.fn();

vi.mock('../src/lib/notifications.js', () => ({
  createNotification: (...args: unknown[]) => createNotification(...args),
}));
vi.mock('../src/lib/email/order-status-email.js', () => ({
  sendOrderStatusEmail: (...args: unknown[]) => sendOrderStatusEmail(...args),
}));

const { notifyOrderStatusChanged } = await import('../src/lib/order-notify.js');

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    buyerId: 'buyer-1',
    buyerName: 'A', buyerEmail: 'a@b.c', buyerPhone: '0500000000',
    buyerAddress: { city: 'TLV', street: 'Main 1' },
    items: [],
    storeSubtotals: {},
    shippingAgorot: 0,
    totalAgorot: 0,
    paymentStatus: 'paid',
    shippingStatus: 'shipped',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  createNotification.mockReset().mockResolvedValue(undefined);
  sendOrderStatusEmail.mockReset().mockResolvedValue(undefined);
});

describe('the notifications table is unavailable', () => {
  it('the status change still stands — the seller is not told their own click failed', async () => {
    createNotification.mockRejectedValue(new Error('relation "notifications" does not exist'));
    await expect(notifyOrderStatusChanged(order(), 'processing')).resolves.toBeUndefined();
  });

  it('the buyer still gets the EMAIL — the channel that reaches guests', async () => {
    // The two channels have unrelated failure modes and unrelated reach: the badge is for the
    // minority with an account, the email is for everyone. One being down must not silence the
    // other, or a database hiccup costs the majority of buyers the only word they ever get.
    createNotification.mockRejectedValue(new Error('down'));
    await notifyOrderStatusChanged(order(), 'processing');
    expect(sendOrderStatusEmail).toHaveBeenCalledTimes(1);
  });
});

describe('the mail provider is down', () => {
  it('does not throw back into the status change', async () => {
    sendOrderStatusEmail.mockRejectedValue(new Error('HTTP 503'));
    await expect(notifyOrderStatusChanged(order(), 'processing')).resolves.toBeUndefined();
  });

  it('does not cost the in-app notification its write', async () => {
    sendOrderStatusEmail.mockRejectedValue(new Error('HTTP 503'));
    await notifyOrderStatusChanged(order(), 'processing');
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});

describe('the mail provider HANGS', () => {
  it('is never waited on, so the seller\'s request returns anyway', async () => {
    // The one that a `try/catch` cannot help with: the call does not fail, it simply never comes
    // back. `outboundFetch`'s deadline bounds it eventually, but the reason the seller does not sit
    // through even that is that the send is `void`ed rather than awaited. Asserted by resolving
    // while the send is still outstanding.
    let stuck = false;
    sendOrderStatusEmail.mockImplementation(() => { stuck = true; return new Promise(() => { /* never */ }); });
    await expect(notifyOrderStatusChanged(order(), 'processing')).resolves.toBeUndefined();
    expect(stuck).toBe(true);
  });
});

describe('nothing to announce', () => {
  it('a status that did not change writes nothing and sends nothing', async () => {
    await notifyOrderStatusChanged(order({ shippingStatus: 'shipped' }), 'shipped');
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendOrderStatusEmail).not.toHaveBeenCalled();
  });

  it('a guest buyer gets the email and no in-app write — there is no account to write to', async () => {
    await notifyOrderStatusChanged(order({ buyerId: undefined }), 'processing');
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendOrderStatusEmail).toHaveBeenCalledTimes(1);
  });
});

describe('the seller order route', () => {
  it('cannot let a failed announcement skip the store closure behind it', async () => {
    // Guarding at the call site is what makes the block's ORDER safe, and the order is the point:
    // `settleStoreClosure` runs after this line and completes a closure the seller asked for and is
    // waiting on. A source assertion because the route needs a session, a store and a database to
    // call — and what is being pinned is the shape, which is exactly what regressed.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/pages/api/seller/orders.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/try\s*\{\s*\n\s*await notifyOrderStatusChanged\([\s\S]{0,200}?\}\s*catch\b/);
  });
});
