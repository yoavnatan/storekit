import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from './mutex.js';

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
 * JSON-file era (AI_INSTRUCTIONS.md → Scalability). Note the single-process
 * assumption: `Mutex` serialises within ONE node process, so this is airtight for
 * today's single-instance deploy and becomes a unique index on `key` plus a
 * transaction after the DB migration — where it is airtight across instances too.
 * That upgrade is REQUIRED before running a second instance; see DB_MIGRATION_PLAN.md.
 */

const LEDGER_PATH = path.join(process.cwd(), 'data/checkout-idempotency.json');
const lock = new Mutex();

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
 * hashed because the ledger is a bookkeeping file that has no reason to hold a second copy of a
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

function readLedger(): CheckoutRecord[] {
  try {
    const all = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) as CheckoutRecord[];
    const cutoff = Date.now() - TTL_MS;
    return all.filter((r) => new Date(r.at).getTime() >= cutoff);
  } catch { return []; }
}

function writeLedger(records: CheckoutRecord[]): void {
  try { fs.writeFileSync(LEDGER_PATH, JSON.stringify(records, null, 2)); }
  catch { /* see completeCheckout — a ledger failure must never undo a real charge */ }
}

/**
 * Atomically decide what this request is allowed to do with `key`.
 *
 * The read and the `pending` write happen inside one lock turn, which is what stops
 * two simultaneous submits from both seeing "no record" and both charging.
 */
export async function claimCheckout(key: string, owner: string): Promise<CheckoutClaim> {
  return lock.run(() => {
    const all = readLedger();
    const existing = all.find((r) => r.key === key);

    if (existing?.status === 'complete') {
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
      if (existing.owner !== owner) return { status: 'conflict' };
      return { status: 'replay', record: existing };
    }
    if (existing?.status === 'pending' && Date.now() - new Date(existing.at).getTime() < PENDING_TTL_MS) {
      return { status: 'in_progress' };
    }

    writeLedger([...all.filter((r) => r.key !== key), { key, status: 'pending', owner, at: new Date().toISOString() }]);
    return { status: 'claimed' };
  });
}

/** Turn our claim into the replayable result. Call this as soon as the orders exist. */
export async function completeCheckout(key: string, checkoutRef: string, orderIds: string[], owner: string): Promise<void> {
  await lock.run(() => {
    const all = readLedger().filter((r) => r.key !== key);
    // `owner` is carried onto the completed record, not just the pending one — the completed record
    // is the only one a replay ever reads.
    all.push({ key, status: 'complete', owner, checkoutRef, orderIds, at: new Date().toISOString() });
    writeLedger(all);
    // A write failure here is swallowed by writeLedger on purpose: the charge has
    // already succeeded and the order rows are the source of truth for the purchase.
    // Losing the key costs this one checkout its replay protection — undoing the
    // purchase over a bookkeeping failure would be far worse.
  });
}

/** Drop a claim whose attempt failed, so the buyer's next try isn't told to wait. */
export async function releaseCheckout(key: string): Promise<void> {
  await lock.run(() => {
    writeLedger(readLedger().filter((r) => !(r.key === key && r.status === 'pending')));
  });
}
