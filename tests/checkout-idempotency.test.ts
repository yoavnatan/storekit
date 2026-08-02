import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { getDatabase, query, setDatabase, type Database } from '../src/lib/db.js';
import {
  checkoutOwner,
  claimCheckout,
  completeCheckout,
  isValidIdempotencyKey,
  purgeExpiredCheckouts,
  releaseCheckout,
} from '../src/lib/checkout-idempotency.js';

/**
 * The double-charge guard.
 *
 * Every case here is a way a buyer really does end up submitting the same purchase
 * twice — a lost response, a refresh, an impatient second click — and each one ends
 * in a real second charge the moment a live gateway sits behind paymentProvider.
 * The mock provider approving everything is what makes this invisible today.
 *
 * **It used to mock `node:fs`, and rewriting it is the point of moving the module**
 * (DB_MIGRATION_PLAN.md §4/§8). A mocked filesystem cannot show the property the move was for: the
 * JSON version serialised its read-modify-write with an in-process `Mutex`, airtight for one node
 * process and worth nothing across two — two instances, two mutexes, two requests both reading
 * "no record", two charges. Against a real primary key the concurrent case below is decided by the
 * database, which is the assertion that could not be written before.
 */

const KEY = 'co-11111111-2222-3333-4444-555555555555';
const OWNER = checkoutOwner('buyer@example.com');

beforeEach(async () => {
  await query('DELETE FROM checkout_idempotency');
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
    expect([a!.status, b!.status].sort()).toEqual(['claimed', 'in_progress']);
  });

  it('lets exactly ONE of five simultaneous submits through', async () => {
    // The claim is one statement — `INSERT … ON CONFLICT DO UPDATE … WHERE <stale>` — whose
    // affected-row count IS the verdict. Being honest about what this proves: PGlite runs on one
    // connection, so these five serialise rather than truly collide, and what is pinned here is
    // that the DECISION lives in the statement — five attempts, one winner, no second charge.
    // Proving it across processes needs the real server (§9.5, stage 3). What matters is that the
    // mutex is gone: the verdict is the database's now, so there is no per-process lock left to
    // be right about.
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimCheckout(KEY, OWNER)));
    expect(claims.filter((c) => c.status === 'claimed')).toHaveLength(1);
    expect(claims.filter((c) => c.status === 'in_progress')).toHaveLength(4);
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
    await claimCheckout(KEY, OWNER);
    await query(`UPDATE checkout_idempotency SET at = now() - interval '10 minutes' WHERE key = $1`, [KEY]);
    expect((await claimCheckout(KEY, OWNER)).status).toBe('claimed');
  });

  it('but a fresh one still does', async () => {
    await claimCheckout(KEY, OWNER);
    await query(`UPDATE checkout_idempotency SET at = now() - interval '5 seconds' WHERE key = $1`, [KEY]);
    expect((await claimCheckout(KEY, OWNER)).status).toBe('in_progress');
  });
});

describe('expiry', () => {
  it('treats the same key a day later as the new purchase it almost certainly is', async () => {
    await claimCheckout(KEY, OWNER);
    await completeCheckout(KEY, 'REF123', ['order-a'], OWNER);
    await query(`UPDATE checkout_idempotency SET at = now() - interval '25 hours' WHERE key = $1`, [KEY]);
    expect((await claimCheckout(KEY, OWNER)).status).toBe('claimed');
  });

  it('has a purge for the rows the file version dropped on every read', async () => {
    // The JSON ledger could not grow: every read filtered by TTL and every write rewrote the file
    // without the expired rows. A table does not clean itself, and `claimCheckout` deliberately
    // does NOT delete on the read path — an unbounded scan in front of the one request that must
    // never be slow is the wrong trade.
    const fresh = 'co-99999999-8888-7777-6666-555555555555';
    await claimCheckout(KEY, OWNER);
    await completeCheckout(KEY, 'REF123', ['order-a'], OWNER);
    await claimCheckout(fresh, OWNER);
    await query(`UPDATE checkout_idempotency SET at = now() - interval '25 hours' WHERE key = $1`, [KEY]);

    expect(await purgeExpiredCheckouts()).toBe(1);
    const { rows } = await query<{ key: string }>('SELECT key FROM checkout_idempotency');
    expect(rows.map((r) => r.key)).toEqual([fresh]);
  });
});

describe('a ledger write failure never undoes a real purchase', () => {
  it('completeCheckout swallows the error rather than throwing into the checkout', async () => {
    // The charge already happened and the orders exist. Throwing here would send the
    // buyer an error for a purchase that went through — inviting exactly the second
    // submit this module exists to prevent. The failure is injected through the db seam
    // (db.ts#setDatabase), which is what replaced the old mocked `writeFileSync`.
    await claimCheckout(KEY, OWNER);
    const real = getDatabase();
    const broken: Database = {
      query: () => Promise.reject(new Error('connection lost')),
      transaction: () => Promise.reject(new Error('connection lost')),
      close: () => Promise.resolve(),
    };
    setDatabase(broken);
    try {
      await expect(completeCheckout(KEY, 'REF123', ['order-a'], OWNER)).resolves.toBeUndefined();
      await expect(releaseCheckout(KEY)).resolves.toBeUndefined();
    } finally {
      setDatabase(real);
    }
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
