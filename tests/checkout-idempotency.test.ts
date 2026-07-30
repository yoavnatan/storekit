import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutRecord } from '../src/lib/checkout-idempotency.js';

/**
 * The double-charge guard.
 *
 * Every case here is a way a buyer really does end up submitting the same purchase
 * twice — a lost response, a refresh, an impatient second click — and each one ends
 * in a real second charge the moment a live gateway sits behind paymentProvider.
 * The mock provider approving everything is what makes this invisible today.
 */

let ledger: CheckoutRecord[] = [];
let failWrites = false;

vi.mock('node:fs', () => ({
  default: {
    readFileSync: () => JSON.stringify(ledger),
    writeFileSync: (_path: string, data: string) => {
      if (failWrites) throw new Error('disk full');
      ledger = JSON.parse(data);
    },
  },
}));

const { claimCheckout, completeCheckout, releaseCheckout, isValidIdempotencyKey, checkoutOwner } =
  await import('../src/lib/checkout-idempotency.js');

const KEY = 'co-11111111-2222-3333-4444-555555555555';
const OWNER = checkoutOwner('buyer@example.com');

beforeEach(() => {
  ledger = [];
  failWrites = false;
});

describe('a repeat submit of a completed checkout is never charged again', () => {
  it('replays the original orders instead of creating new ones', async () => {
    // First attempt: claims the key, charges, records its result.
    expect((await claimCheckout(KEY, OWNER)).status).toBe('claimed');
    await completeCheckout(KEY, 'REF123', ['order-a', 'order-b'], OWNER);

    // The response never reached the buyer, so they pressed pay again with the SAME
    // key (checkout-attempt-key.ts persists it across a failed attempt).
    const second = await claimCheckout(KEY, OWNER);
    expect(second.status).toBe('replay');
    if (second.status !== 'replay') throw new Error('unreachable');
    expect(second.record.orderIds).toEqual(['order-a', 'order-b']);
    expect(second.record.checkoutRef).toBe('REF123');
  });

  it('replays indefinitely, not just once', async () => {
    await claimCheckout(KEY, OWNER);
    await completeCheckout(KEY, 'REF123', ['order-a'], OWNER);
    for (let i = 0; i < 3; i++) expect((await claimCheckout(KEY, OWNER)).status).toBe('replay');
  });
});

describe('two submits racing each other', () => {
  it('only one is allowed to charge', async () => {
    // Both fire before either finishes — the exact double-click case a disabled
    // button does not cover once the request is already in flight.
    const [a, b] = await Promise.all([claimCheckout(KEY, OWNER), claimCheckout(KEY, OWNER)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['claimed', 'in_progress']);
  });

  it('the loser is refused rather than queued behind the winner', async () => {
    // Refusing is the safe answer: we cannot know yet whether the first attempt will
    // charge, so we must not start a second. The client tells the buyer to wait
    // (i18n `checkoutInProgress`) instead of "try again".
    await claimCheckout(KEY, OWNER);
    expect((await claimCheckout(KEY, OWNER)).status).toBe('in_progress');
  });
});

describe('a failed attempt does not lock the buyer out', () => {
  it('releasing the claim lets an immediate retry through', async () => {
    // Declined card, out of stock, a validation error — the buyer fixes it and tries
    // again within seconds. Making them wait out the pending TTL would be a bug of
    // our own making.
    expect((await claimCheckout(KEY, OWNER)).status).toBe('claimed');
    await releaseCheckout(KEY);
    expect((await claimCheckout(KEY, OWNER)).status).toBe('claimed');
  });

  it('releasing never destroys a COMPLETED record', async () => {
    // Guards the ordering mistake: if a post-commit failure path called release
    // after complete, the buyer's retry would be charged for real orders that
    // already exist.
    await claimCheckout(KEY, OWNER);
    await completeCheckout(KEY, 'REF123', ['order-a'], OWNER);
    await releaseCheckout(KEY);
    expect((await claimCheckout(KEY, OWNER)).status).toBe('replay');
  });
});

describe('an abandoned claim is reclaimable', () => {
  it('a pending marker older than the TTL no longer blocks', async () => {
    // The process died between claiming and charging. Nothing will ever complete or
    // release this key, so it must not block the buyer forever.
    ledger = [{ key: KEY, status: 'pending', at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }];
    expect((await claimCheckout(KEY, OWNER)).status).toBe('claimed');
  });

  it('but a fresh one still does', async () => {
    ledger = [{ key: KEY, status: 'pending', at: new Date(Date.now() - 5_000).toISOString() }];
    expect((await claimCheckout(KEY, OWNER)).status).toBe('in_progress');
  });
});

describe('a ledger write failure never undoes a real purchase', () => {
  it('completeCheckout swallows the error rather than throwing into the checkout', async () => {
    // The charge already happened and the orders exist. Throwing here would send the
    // buyer an error for a purchase that went through — inviting exactly the second
    // submit this module exists to prevent.
    await claimCheckout(KEY, OWNER);
    failWrites = true;
    await expect(completeCheckout(KEY, 'REF123', ['order-a'], OWNER)).resolves.toBeUndefined();
  });
});

describe('keys are distinct per purchase', () => {
  it('a different key is a different purchase', async () => {
    await claimCheckout(KEY, OWNER);
    await completeCheckout(KEY, 'REF123', ['order-a'], OWNER);
    // The buyer's NEXT, genuinely new order. checkout-attempt-key.ts clears the key
    // on success precisely so this is not mistaken for a replay.
    expect((await claimCheckout('co-99999999-8888-7777-6666-555555555555', OWNER)).status).toBe('claimed');
  });
});

describe('the key itself is validated as untrusted input', () => {
  it('accepts the shape the client mints', () => {
    expect(isValidIdempotencyKey(`co-${crypto.randomUUID()}`)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of [undefined, null, 42, {}, '', 'short', 'a'.repeat(129), '../../etc/passwd', 'has space', '<script>']) {
      expect(isValidIdempotencyKey(bad), String(bad)).toBe(false);
    }
  });
});
