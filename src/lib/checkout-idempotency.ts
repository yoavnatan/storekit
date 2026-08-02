import crypto from 'node:crypto';
import { firstRow, query, withTransaction } from './db.js';

/**
 * Stops a buyer being charged twice for one checkout.
 *
 * /api/checkout used to mint its own `checkoutRef` per REQUEST, which meant it had
 * no way to tell a genuine second purchase from the same purchase arriving twice.
 * Disabling the submit button covers a double-click on one live page and nothing
 * else. The cases it does not cover all end in a real second charge once a real
 * gateway is behind paymentProvider:
 *
 *   • The request succeeds server-side but the response is lost (timeout, dropped
 *     connection, a phone changing network). The client shows an error and
 *     re-enables the button; the buyer presses it again.
 *   • The buyer refreshes or navigates back mid-request — new page, fresh button,
 *     cart still full because the success redirect never ran.
 *   • Anything replaying the POST: a proxy retry, a service worker, a direct call.
 *
 * The fix is the standard one: the CLIENT mints a key per checkout attempt and
 * reuses it across retries; the server does the charge at most once per key. The
 * key must survive a failed attempt on the client — that is the whole point. A
 * client that mints a fresh key on retry gets no protection against the timeout
 * case, which is the case most likely to actually charge twice.
 *
 * The flow is claim → work → complete/release, rather than one wrapping callback,
 * so the endpoint's existing body stays where it is:
 *
 *   claimCheckout(key)     — atomically either hands back the finished result of an
 *                            earlier attempt, refuses because one is in flight, or
 *                            claims the key by writing a `pending` marker.
 *   completeCheckout(...)  — turns the marker into the replayable result.
 *   releaseCheckout(key)   — drops the marker when the attempt failed, so an
 *                            immediate retry isn't told to wait out the TTL.
 *
 * **THE MUTEX IS GONE, AND THAT IS THE ENTIRE POINT OF MOVING THIS FILE
 * (DB_MIGRATION_PLAN.md §4).** The JSON version serialised its read-modify-write with an
 * in-process `Mutex`, which is airtight for exactly one node process and worth nothing across two:
 * two instances meant two mutexes, two requests both reading "no record", and two charges for one
 * purchase — the failure this module exists to prevent, reintroduced by the deploy that scaled it.
 * The claim is now `INSERT … ON CONFLICT DO UPDATE … WHERE <the record is stale>`, one statement,
 * whose affected-row count IS the verdict: 1 = the key is ours, 0 = somebody else holds it, at any
 * number of instances. That upgrade was the documented gate on running more than one; it is done.
 *
 * It also had to move in the same change as `orders`. The two are one operation from the buyer's
 * side — charge, write the order rows, record that this key is spent — and a ledger in a file
 * beside orders in a transaction means a process that dies between them leaves a paid order whose
 * key says the checkout never completed. The next retry charges again.
 */

/** How long a completed key is replayable. Long enough to cover any plausible retry,
 *  short enough that the ledger stays small. Past this, a repeat submit is treated as
 *  a NEW purchase — which, a day later, it almost certainly is. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** How long a `pending` claim blocks a concurrent attempt before being considered
 *  abandoned. Covers a slow gateway round-trip; past it we assume the process died
 *  mid-checkout and let the next attempt take the key over. */
const PENDING_TTL_MS = 2 * 60 * 1000;

export interface CheckoutRecord {
  key: string;
  status: 'pending' | 'complete';
  /** Who this record belongs to — see `checkoutOwner`. Absent on records written before
   *  ownership existed; `claimCheckout` documents how those are treated. */
  owner?: string;
  /** The result the first request produced, replayed verbatim to any repeat. */
  checkoutRef?: string;
  orderIds?: string[];
  at: string;
}

export type CheckoutClaim =
  /** This key already completed — return `record`'s result, charge nothing. */
  | { status: 'replay'; record: CheckoutRecord }
  /** Another request holds this key right now. */
  | { status: 'in_progress' }
  /** This key completed for a DIFFERENT buyer. Not a retry; refuse and reveal nothing. */
  | { status: 'conflict' }
  /** The key is ours; proceed to charge. */
  | { status: 'claimed' };

/**
 * A stable, opaque identity for the buyer behind a checkout, so a completed record can only be
 * replayed to whoever created it.
 *
 * Keyed on the email rather than the session, deliberately: the same attempt must produce the same
 * owner whether the buyer is logged in or a guest, and a guest has no session to key on. It is
 * hashed because the ledger is a bookkeeping table that has no reason to hold a second copy of a
 * buyer's address.
 *
 * This raises the bar; it is not a secret. An attacker who knew both a completed key and the
 * buyer's email could still replay. The key is 122 bits of `crypto.randomUUID` on any modern
 * browser, so that is a defence-in-depth layer behind the real one.
 */
export function checkoutOwner(buyerEmail: string): string {
  return crypto.createHash('sha256').update(`email:${buyerEmail.trim().toLowerCase()}`).digest('hex');
}

/** A key is client-supplied and therefore untrusted: bounded length, and an opaque
 *  token charset so it can never be anything but a lookup value. */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(key);
}

interface LedgerRow {
  key: string;
  status: 'pending' | 'complete';
  owner: string | null;
  checkout_ref: string | null;
  order_ids: string[] | null;
  at: Date | string;
}

function toRecord(row: LedgerRow): CheckoutRecord {
  const record: CheckoutRecord = {
    key: row.key,
    status: row.status,
    at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString(),
  };
  if (row.owner) record.owner = row.owner;
  if (row.checkout_ref) record.checkoutRef = row.checkout_ref;
  if (row.order_ids?.length) record.orderIds = row.order_ids;
  return record;
}

/**
 * Atomically decide what this request is allowed to do with `key`.
 *
 * One statement does the deciding. The `INSERT` wins when nothing holds the key; the `ON CONFLICT`
 * branch takes it over only when what is there is STALE — expired outright, or a `pending` claim
 * older than `PENDING_TTL_MS`, meaning the process that made it died mid-checkout. Anything else
 * fails the `WHERE`, updates nothing, and returns zero rows, which is how this request learns it
 * did not get the key. There is no window between deciding and writing, because they are the same
 * statement; the mutex the file version needed was only ever an approximation of that.
 *
 * The read that follows a zero-row claim is what distinguishes the three ways of losing: a
 * completed record belonging to this buyer is a replay, one belonging to someone else is a
 * conflict, and a live `pending` marker is another attempt in flight.
 */
export async function claimCheckout(key: string, owner: string): Promise<CheckoutClaim> {
  return withTransaction(async (tx) => {
    const nowMs = Date.now();
    const expiredAt = new Date(nowMs - TTL_MS).toISOString();
    const pendingCutoff = new Date(nowMs - PENDING_TTL_MS).toISOString();

    const claimed = await tx.query<{ key: string }>(
      `INSERT INTO checkout_idempotency (key, status, owner, at)
       VALUES ($1, 'pending', $2, now())
       ON CONFLICT (key) DO UPDATE
          SET status = 'pending', owner = $2, checkout_ref = NULL, order_ids = '{}', at = now()
        WHERE checkout_idempotency.at < $3::timestamptz
           OR (checkout_idempotency.status = 'pending' AND checkout_idempotency.at < $4::timestamptz)
       RETURNING key`,
      [key, owner, expiredAt, pendingCutoff],
    );
    if (claimed.rows.length) return { status: 'claimed' };

    const [row] = (await tx.query<LedgerRow>(
      'SELECT key, status, owner, checkout_ref, order_ids, at FROM checkout_idempotency WHERE key = $1',
      [key],
    )).rows;
    // The row was there a statement ago; if it is gone now another request expired it out from
    // under us, and the honest answer is "someone else is working on this key" rather than a
    // second charge.
    if (!row) return { status: 'in_progress' };

    if (row.status === 'complete') {
      // A completed record is replayed only to the buyer who produced it. Without this check the
      // key IS the authorisation, and the replay response carries the original `orderIds` and
      // `checkoutRef` — so anyone presenting a matching key would be handed another buyer's order
      // references.
      // An owner-LESS record is refused too, and that is a deliberate tightening of the first
      // version of this check (`existing.owner && existing.owner !== owner`, which let one through).
      // That exemption was written for records predating ownership, on the reasoning that refusing
      // an in-flight retry risks the double charge this module exists to prevent. Both halves of it
      // were wrong: `claimCheckout` has always written an owner, records expire after TTL_MS, and
      // the ledger holds none — so the case it protected cannot occur. And the reasoning does not
      // even apply to this branch: `status === 'complete'` means the charge already happened, so
      // refusing here returns 409 and charges nothing. There is no double-charge risk to trade
      // against, which left a permanent bypass guarding an empty set.
      if (row.owner !== owner) return { status: 'conflict' };
      return { status: 'replay', record: toRecord(row) };
    }
    return { status: 'in_progress' };
  });
}

/**
 * Turn our claim into the replayable result. Call this as soon as the orders exist.
 *
 * A failure here is swallowed on purpose, exactly as the file version swallowed a write error: the
 * charge has already succeeded and the order rows are the source of truth for the purchase. Losing
 * the key costs this one checkout its replay protection — throwing, and unwinding the caller over
 * a bookkeeping failure, would undo a purchase that really happened.
 */
export async function completeCheckout(key: string, checkoutRef: string, orderIds: string[], owner: string): Promise<void> {
  try {
    await query(
      `INSERT INTO checkout_idempotency (key, status, owner, checkout_ref, order_ids, at)
       VALUES ($1, 'complete', $2, $3, $4::text[], now())
       ON CONFLICT (key) DO UPDATE
          SET status = 'complete', owner = $2, checkout_ref = $3, order_ids = $4::text[], at = now()`,
      // `owner` is carried onto the completed record, not just the pending one — the completed
      // record is the only one a replay ever reads.
      [key, owner, checkoutRef, orderIds],
    );
  } catch { /* see above — a ledger failure must never undo a real charge */ }
}

/** Drop a claim whose attempt failed, so the buyer's next try isn't told to wait.
 *  Scoped to `pending`: a completed record is the replay protection itself and deleting it here
 *  would turn a late-failing caller's cleanup into permission to charge the buyer again. */
export async function releaseCheckout(key: string): Promise<void> {
  try {
    await query(`DELETE FROM checkout_idempotency WHERE key = $1 AND status = 'pending'`, [key]);
  } catch { /* same reasoning as completeCheckout */ }
}

/**
 * Drop records past the replay window.
 *
 * The file version did this implicitly — every read filtered by TTL and every write rewrote the
 * file without the expired rows, so the ledger could not grow. A table does not clean itself, and
 * `claimCheckout` deliberately does NOT delete on the read path: an expired row is taken over by
 * the `ON CONFLICT` branch when its key comes back, and a `DELETE` on every checkout would put an
 * unbounded scan in front of the one request that must never be slow.
 *
 * Not wired to a scheduler yet — there is no scheduler (DB_MIGRATION_PLAN §8 stage 4 is where one
 * arrives, and GO_LIVE §6.1 is already waiting for it). Exported and tested so that when it lands,
 * the job is a call rather than a design.
 */
export async function purgeExpiredCheckouts(): Promise<number> {
  const row = await firstRow<{ count: string | number }>(
    `WITH gone AS (DELETE FROM checkout_idempotency WHERE at < $1::timestamptz RETURNING 1)
     SELECT COUNT(*)::bigint AS count FROM gone`,
    [new Date(Date.now() - TTL_MS).toISOString()],
  );
  return Number(row?.count ?? 0);
}
