import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import { checkoutOwner, claimCheckout, completeCheckout } from '../src/lib/checkout-idempotency.js';

/**
 * Who a completed checkout may be replayed to.
 *
 * The replay response carries the original `orderIds` and `checkoutRef`. Before ownership existed,
 * the idempotency key alone decided who received them — so the key was, in effect, a bearer token
 * for another buyer's order references, and the only thing standing in the way was that keys are
 * hard to guess. Kept in its own file rather than folded into checkout-idempotency.test.ts, which
 * covers the double-charge behaviour.
 *
 * Runs against the real ledger table since the module moved (DB_MIGRATION_PLAN.md §4): the
 * "stores the owner as a digest" assertion is only worth something against the row that is
 * actually written, and against a mocked filesystem it was checking a fixture the test wrote
 * itself.
 */

const KEY = 'co-11111111-2222-3333-4444-555555555555';
const BUYER = checkoutOwner('buyer@example.com');
const OTHER = checkoutOwner('attacker@example.com');

interface Row { key: string; status: string; owner: string | null; order_ids: string[] | null }
const ledgerRows = async (): Promise<Row[]> =>
  (await query<Row>('SELECT key, status, owner, order_ids FROM checkout_idempotency')).rows;

beforeEach(async () => {
  await query('DELETE FROM checkout_idempotency');
});

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
    // The original record survives the refusal untouched — including its owner, so the real
    // buyer's own retry still replays after the attempt.
    const [row] = await ledgerRows();
    expect(row?.order_ids).toEqual(['order-a']);
    expect(row?.owner).toBe(BUYER);
    expect((await claimCheckout(KEY, BUYER)).status).toBe('replay');
  });

  it('treats the email as the identity, so login state does not change it', () => {
    // The same attempt must resolve to the same owner whether the buyer is signed in or a guest —
    // a guest has no session to key on, and a mid-checkout login must not turn a retry into a
    // conflict that hard-blocks a real buyer.
    expect(checkoutOwner('Buyer@Example.com  ')).toBe(BUYER);
  });

  it('stores the owner as a digest, never the address itself', async () => {
    await claimCheckout(KEY, BUYER);
    await completeCheckout(KEY, 'REF123', ['order-a'], BUYER);

    expect(JSON.stringify(await ledgerRows())).not.toContain('buyer@example.com');
    expect(BUYER).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('a completed record carrying NO owner', () => {
  // This used to be exempted — "records written before ownership existed stay replayable for the
  // rest of their TTL" — on the reasoning that refusing an in-flight retry risks a double charge.
  // Both halves were wrong. `claimCheckout` has always written an owner and records expire after
  // TTL_MS, so the population is empty; and on a COMPLETE record the charge has already happened,
  // so refusing returns a conflict and charges nothing. There was no double-charge risk to trade
  // against, only a permanent bypass. Such a record can now arise only from a hand-edited row or a
  // restored backup, and an unattributable completed checkout is exactly what must not be handed
  // to whoever asks.
  const writeLegacy = () => query(
    `INSERT INTO checkout_idempotency (key, status, owner, checkout_ref, order_ids, at)
     VALUES ($1, 'complete', NULL, 'REF-LEGACY', ARRAY['order-legacy'], now())`, [KEY],
  );

  it('is refused, and leaks no order references to anyone', async () => {
    await writeLegacy();
    const a = await claimCheckout(KEY, BUYER);
    expect(a.status).toBe('conflict');
    expect(a).not.toHaveProperty('record');
    expect((await claimCheckout(KEY, OTHER)).status).toBe('conflict');
  });

  it('is not charged a second time by the refusal', async () => {
    // The reason refusing is safe here: a conflict must not fall through to `claimed`, and the
    // record it refused must survive intact.
    await writeLegacy();
    expect((await claimCheckout(KEY, OTHER)).status).toBe('conflict');
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.order_ids).toEqual(['order-legacy']);
    expect(rows[0]!.status).toBe('complete');
  });
});
