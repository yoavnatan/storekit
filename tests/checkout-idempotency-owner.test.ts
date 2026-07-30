import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutRecord } from '../src/lib/checkout-idempotency.js';

/**
 * Who a completed checkout may be replayed to.
 *
 * The replay response carries the original `orderIds` and `checkoutRef`. Before ownership existed,
 * the idempotency key alone decided who received them — so the key was, in effect, a bearer token
 * for another buyer's order references, and the only thing standing in the way was that keys are
 * hard to guess. Kept in its own file rather than folded into checkout-idempotency.test.ts, which
 * covers the double-charge behaviour and is being edited in parallel.
 */

let ledger: CheckoutRecord[] = [];

vi.mock('node:fs', () => ({
  default: {
    readFileSync: () => JSON.stringify(ledger),
    writeFileSync: (_path: string, data: string) => { ledger = JSON.parse(data); },
  },
}));

const { claimCheckout, completeCheckout, checkoutOwner } =
  await import('../src/lib/checkout-idempotency.js');

const KEY = 'co-11111111-2222-3333-4444-555555555555';
const BUYER = checkoutOwner('buyer@example.com');
const OTHER = checkoutOwner('attacker@example.com');

beforeEach(() => { ledger = []; });

describe('a completed key is replayed only to the buyer who completed it', () => {
  it('still replays to the original buyer — the double-charge guard is untouched', async () => {
    expect((await claimCheckout(KEY, BUYER)).status).toBe('claimed');
    await completeCheckout(KEY, 'REF123', ['order-a'], BUYER);

    const retry = await claimCheckout(KEY, BUYER);
    expect(retry.status).toBe('replay');
    if (retry.status === 'replay') expect(retry.record.orderIds).toEqual(['order-a']);
  });

  it('refuses a different buyer presenting the same key, and hands back no order data', async () => {
    await claimCheckout(KEY, BUYER);
    await completeCheckout(KEY, 'REF123', ['order-a'], BUYER);

    const stolen = await claimCheckout(KEY, OTHER);
    expect(stolen.status).toBe('conflict');
    // The point is the absence: a conflict carries no record, so there is nothing to leak.
    expect(stolen).not.toHaveProperty('record');
  });

  it('does not let the refusal become a way to charge twice', async () => {
    // A conflict must not fall through to `claimed` — that would start a second charge against a
    // key that already completed, which is the exact failure this module exists to prevent.
    await claimCheckout(KEY, BUYER);
    await completeCheckout(KEY, 'REF123', ['order-a'], BUYER);

    expect((await claimCheckout(KEY, OTHER)).status).toBe('conflict');
    // The original record survives the refusal untouched.
    expect(ledger.find((r) => r.key === KEY)?.orderIds).toEqual(['order-a']);
  });

  it('treats the email as the identity, so login state does not change it', async () => {
    // The same attempt must resolve to the same owner whether the buyer is signed in or a guest —
    // a guest has no session to key on, and a mid-checkout login must not turn a retry into a
    // conflict that hard-blocks a real buyer.
    expect(checkoutOwner('Buyer@Example.com  ')).toBe(BUYER);
  });

  it('stores the owner as a digest, never the address itself', async () => {
    await claimCheckout(KEY, BUYER);
    await completeCheckout(KEY, 'REF123', ['order-a'], BUYER);

    const raw = JSON.stringify(ledger);
    expect(raw).not.toContain('buyer@example.com');
    expect(BUYER).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('a completed record carrying NO owner', () => {
  // This used to be exempted — "records written before ownership existed stay replayable for the
  // rest of their TTL" — on the reasoning that refusing an in-flight retry risks a double charge.
  // Both halves were wrong. `claimCheckout` has always written an owner and records expire after
  // TTL_MS, so the population is empty; and on a COMPLETE record the charge has already happened,
  // so refusing returns a conflict and charges nothing. There was no double-charge risk to trade
  // against, only a permanent bypass. Such a record can now arise only from a hand-edited or
  // corrupted ledger, and an unattributable completed checkout is exactly what must not be handed
  // to whoever asks.
  const legacy = () => [{
    key: KEY,
    status: 'complete' as const,
    checkoutRef: 'REF-LEGACY',
    orderIds: ['order-legacy'],
    at: new Date().toISOString(),
  }];

  it('is refused, and leaks no order references to anyone', async () => {
    ledger = legacy();
    const a = await claimCheckout(KEY, BUYER);
    expect(a.status).toBe('conflict');
    expect(a).not.toHaveProperty('record');

    ledger = legacy();
    expect((await claimCheckout(KEY, OTHER)).status).toBe('conflict');
  });

  it('is not charged a second time by the refusal', async () => {
    // The reason refusing is safe here: a conflict must not fall through to `claimed`, and the
    // record it refused must survive intact.
    ledger = legacy();
    expect((await claimCheckout(KEY, OTHER)).status).toBe('conflict');
    expect(ledger.find((r) => r.key === KEY)?.orderIds).toEqual(['order-legacy']);
    expect(ledger.filter((r) => r.key === KEY)).toHaveLength(1);
  });
});
