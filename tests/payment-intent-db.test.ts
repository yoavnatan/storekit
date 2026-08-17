/**
 * The checkout held between two requests, against a real Postgres.
 *
 * Every case here is a way a hosted-payment-page checkout takes the wrong money or lets the wrong
 * person finish it, and each is a rule the module exists to make unbreakable rather than a
 * behaviour it happens to have:
 *
 *  · the intent id travels in the buyer's URL, so reading one must require saying whose it is;
 *  · a reload must resume the same intent, never reserve a second one for the same attempt;
 *  · a replayed redirect must not walk a settled payment backwards or capture twice — Hyp document
 *    no idempotency key on their capture call, so this guard is the only one there is;
 *  · the sweep must never touch an intent that names a real hold on a real card.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { query } from '../src/lib/db.js';
import {
  createIntent, loadIntentFor, markAuthorized, markSettled, markFailed, expireAbandonedIntents,
  type IntentSnapshot,
} from '../src/lib/payment-intent.js';

const OWNER = 'owner-hash-a';
const OTHER = 'owner-hash-b';

function snapshot(ref = 'CHK-1'): IntentSnapshot {
  return { checkoutRef: ref, buyer: { email: 'b@example.com' }, items: [{ id: 'p1', qty: 1 }], storeSubtotals: { shop: { subtotalAgorot: 5000 } } };
}

function key(): string {
  return crypto.randomBytes(16).toString('hex');
}

beforeEach(async () => {
  await query('DELETE FROM payment_intents');
});

describe('starting an intent', () => {
  it('stores the amount and the snapshot it was priced at', async () => {
    const intent = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 12345, snapshot: snapshot() });
    expect(intent.status).toBe('pending');
    expect(intent.amountAgorot).toBe(12345);
    expect(intent.snapshot.checkoutRef).toBe('CHK-1');
    expect(new Date(intent.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns the SAME intent for a repeated key, rather than reserving a second one', async () => {
    // A buyer who reloads the payment page, or a browser that retries the POST. Two intents for one
    // attempt is two holds on one cart and two ways to be charged.
    const k = key();
    const first = await createIntent({ idempotencyKey: k, owner: OWNER, amountAgorot: 5000, snapshot: snapshot('CHK-A') });
    const second = await createIntent({ idempotencyKey: k, owner: OWNER, amountAgorot: 9999, snapshot: snapshot('CHK-B') });
    expect(second.id).toBe(first.id);
    // Untouched: the snapshot is what the buyer was SHOWN, and the amount is what they agreed to.
    expect(second.amountAgorot).toBe(5000);
    expect(second.snapshot.checkoutRef).toBe('CHK-A');
    const { rows } = await query('SELECT count(*)::int AS n FROM payment_intents');
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('refuses a non-positive amount at the database, not only in code', async () => {
    await expect(createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 0, snapshot: snapshot() }))
      .rejects.toThrow();
  });
});

describe('reading an intent', () => {
  it('is found by its owner', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    expect((await loadIntentFor(made.id, OWNER))?.id).toBe(made.id);
  });

  it('is INVISIBLE to anybody else, id or no id', async () => {
    // The id travels in a URL in the buyer's browser. `project_checkout_idempotency_ownership`:
    // an id is not a permission, and the check lives in the WHERE so no future edit can forget it.
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    expect(await loadIntentFor(made.id, OTHER)).toBeNull();
  });

  it('treats a malformed id as a miss rather than a 500', async () => {
    // It arrives from a URL; Postgres raises on a uuid it cannot parse, which would turn a typo
    // into an error page instead of "that checkout is gone".
    expect(await loadIntentFor('not-a-uuid', OWNER)).toBeNull();
  });
});

describe('the money states', () => {
  it('records the hold, then the settlement', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    const held = await markAuthorized(made.id, 'HYP-1', { acode: '123', uid: 'u' });
    expect(held?.status).toBe('authorized');
    expect(held?.providerRef).toBe('HYP-1');
    expect(held?.providerData).toMatchObject({ acode: '123' });
    expect((await markSettled(made.id))?.status).toBe('settled');
  });

  it('refuses a second authorization of the same intent', async () => {
    // A replayed redirect — the buyer's back button, or a provider retrying its callback.
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    expect(await markAuthorized(made.id, 'HYP-1', {})).not.toBeNull();
    expect(await markAuthorized(made.id, 'HYP-2', {})).toBeNull();
  });

  it('refuses to settle an intent that was never authorized', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    expect(await markSettled(made.id)).toBeNull();
  });

  it('refuses to settle twice — the only capture guard there is', async () => {
    // Hyp document no idempotency key on `action=soft` (payment-hyp.ts's header), so nothing on
    // their side would stop a second capture. This is the stop.
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    await markAuthorized(made.id, 'HYP-1', {});
    expect(await markSettled(made.id)).not.toBeNull();
    expect(await markSettled(made.id)).toBeNull();
  });

  it('will not authorize an intent whose window has closed', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot(), ttlMs: -1000 });
    expect(await markAuthorized(made.id, 'HYP-1', {})).toBeNull();
  });

  it('records why a payment died, without losing what the provider had said', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    await markAuthorized(made.id, 'HYP-1', { acode: 'keep-me' });
    await markFailed(made.id, 'capture refused CCode=033');
    const after = await loadIntentFor(made.id, OWNER);
    expect(after?.status).toBe('failed');
    expect(after?.providerData).toMatchObject({ acode: 'keep-me', failure: 'capture refused CCode=033' });
  });

  it('leaves a settled intent alone when a late failure arrives', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    await markAuthorized(made.id, 'HYP-1', {});
    await markSettled(made.id);
    await markFailed(made.id, 'late');
    expect((await loadIntentFor(made.id, OWNER))?.status).toBe('settled');
  });
});

describe('the sweep', () => {
  it('expires a buyer who opened the payment page and walked away', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot('CHK-GONE'), ttlMs: -1000 });
    const swept = await expireAbandonedIntents();
    expect(swept.map((i) => i.id)).toContain(made.id);
    // The snapshot comes back, because it is what a caller needs to put the stock back.
    expect(swept[0]?.snapshot.checkoutRef).toBe('CHK-GONE');
  });

  it('NEVER touches an authorized intent, however old', async () => {
    // It names a hold on a real person's card. Expiring our own record would leave the money
    // reserved at the provider with nothing pointing at it; that needs a void, not a sweep.
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot(), ttlMs: -1000 });
    await query('UPDATE payment_intents SET status = $2 WHERE id = $1', [made.id, 'authorized']);
    expect(await expireAbandonedIntents()).toEqual([]);
    expect((await loadIntentFor(made.id, OWNER))?.status).toBe('authorized');
  });

  it('leaves an intent that still has time', async () => {
    const made = await createIntent({ idempotencyKey: key(), owner: OWNER, amountAgorot: 100, snapshot: snapshot() });
    expect(await expireAbandonedIntents()).toEqual([]);
    expect((await loadIntentFor(made.id, OWNER))?.status).toBe('pending');
  });
});
