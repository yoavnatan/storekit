/**
 * The checkout, held between the request that starts a payment and the request that finishes it.
 *
 * **Why this exists at all.** `/api/checkout` was written against a gateway you can charge from the
 * server: validate, authorize, write orders, capture — one handler, no gaps. Every Israeli gateway
 * that keeps this codebase out of PCI scope works the other way: the buyer authorizes on the
 * provider's own page (an iframe on ours, owner 2026-08-17), and our server hears about it from the
 * redirect that brings them back. One handler becomes two, with a human in between, and everything
 * the second one needs has to survive that gap. This module is that gap.
 *
 * **The rule this module exists to enforce: the return leg trusts NOTHING it is handed.** The buyer
 * comes back with an intent id in a URL, and that id is an identifier and never a permission — the
 * lesson `checkout-idempotency.ts#checkoutOwner` records after a hard-to-guess reference turned out
 * to be enough to replay someone else's checkout. So `loadIntentFor` takes the owner and matches on
 * it in the same statement; there is no way to read an intent without saying whose it is. Amounts
 * are read from the row, never from the redirect: the provider's answer says a payment succeeded,
 * and the row says what was agreed.
 *
 * **Statuses, and why 'authorized' is separate from 'settled'.** `payment.ts` argues the ordering at
 * length — money may be taken only if the order exists, and the order may exist only if money was
 * really taken — so the intent has to be able to say "the hold exists, the orders do not yet". A
 * crash in that window leaves a row that names a real hold with no orders behind it, which is the
 * one state an operator must be able to find. `pending → authorized → settled` is that story;
 * `failed` and `expired` are its two dead ends.
 */
import { getDatabase } from './db.js';

/** How long a buyer has to finish paying before the intent is abandoned and its stock released.
 *  Long enough for 3-D Secure and a hunt for a card; short enough that an abandoned cart does not
 *  hold someone else's last unit for an afternoon. ⚠️ Placeholder — it belongs with the other
 *  windows the owner has yet to rule on (`order-sla.ts` carries the same warning). */
export const INTENT_TTL_MS = 30 * 60 * 1000;

export type PaymentIntentStatus = 'pending' | 'authorized' | 'settled' | 'failed' | 'expired';

/** What was agreed, at the moment the buyer was sent to pay. Read once, whole, by the request that
 *  finishes the checkout — nothing queries inside it, which is why it is one JSONB column. */
export interface IntentSnapshot {
  checkoutRef: string;
  buyer: Record<string, unknown>;
  items: unknown[];
  storeSubtotals: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PaymentIntent {
  id: string;
  idempotencyKey: string;
  owner: string;
  status: PaymentIntentStatus;
  amountAgorot: number;
  snapshot: IntentSnapshot;
  providerRef?: string;
  providerData?: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

interface IntentRow {
  id: string;
  idempotency_key: string;
  owner: string;
  status: PaymentIntentStatus;
  amount_agorot: string | number;
  snapshot: IntentSnapshot;
  provider_ref: string | null;
  provider_data: Record<string, unknown> | null;
  expires_at: Date | string;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIntent(row: IntentRow): PaymentIntent {
  const intent: PaymentIntent = {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    owner: row.owner,
    status: row.status,
    // `bigint` comes back from pg as a STRING, and `Number` on it silently produces a float for
    // anything past 2^53. Amounts here are agorot and nowhere near that, but the conversion is
    // written once and explicitly rather than left to look like an accident.
    amountAgorot: Number(row.amount_agorot),
    snapshot: row.snapshot,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
  if (row.provider_ref) intent.providerRef = row.provider_ref;
  if (row.provider_data) intent.providerData = row.provider_data;
  return intent;
}

/**
 * Start an intent, or hand back the one this key already has.
 *
 * **The `ON CONFLICT` is the point, not an optimisation.** A buyer who reloads the payment page, or
 * whose browser retries the POST, must land on the SAME intent — otherwise every reload reserves
 * the stock again and prices the cart again, and two intents for one attempt is two ways to be
 * charged. The idempotency key is the identity, exactly as it is for `checkout_claims`, so this
 * table carries the same UNIQUE and the same reasoning.
 *
 * A conflicting row is returned untouched rather than refreshed: its snapshot is what the buyer was
 * shown and its expiry is the window they were given, and quietly extending either would mean the
 * page in front of them no longer describes the row behind it.
 */
export async function createIntent(input: {
  idempotencyKey: string;
  owner: string;
  amountAgorot: number;
  snapshot: IntentSnapshot;
  ttlMs?: number;
}): Promise<PaymentIntent> {
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? INTENT_TTL_MS)).toISOString();
  const { rows } = await getDatabase().query<IntentRow>(
    `INSERT INTO payment_intents (idempotency_key, owner, amount_agorot, snapshot, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING *`,
    [input.idempotencyKey, input.owner, input.amountAgorot, JSON.stringify(input.snapshot), expiresAt],
  );
  return toIntent(rows[0]!);
}

/**
 * Read an intent, and only if it belongs to this buyer.
 *
 * The owner is part of the WHERE and not checked afterwards, so there is no branch a future edit
 * can forget to write and no shape of this function that returns somebody else's row.
 */
export async function loadIntentFor(id: string, owner: string): Promise<PaymentIntent | null> {
  // A malformed id must be a miss, not a 500: this value arrives in a URL, and Postgres raises on
  // a uuid it cannot parse, which would turn a typo into an error page.
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  const { rows } = await getDatabase().query<IntentRow>(
    'SELECT * FROM payment_intents WHERE id = $1 AND owner = $2',
    [id, owner],
  );
  return rows[0] ? toIntent(rows[0]) : null;
}

/**
 * Record that the provider is holding the money.
 *
 * Guarded on `status = 'pending'`, so a replayed redirect cannot walk a settled intent backwards,
 * and an expired one cannot be revived by a browser that sat on the page too long. Returns null
 * when the guard refuses, which is the caller's signal to treat the redirect as stale rather than
 * to capture against it.
 */
export async function markAuthorized(id: string, providerRef: string, providerData: Record<string, unknown>): Promise<PaymentIntent | null> {
  const { rows } = await getDatabase().query<IntentRow>(
    `UPDATE payment_intents
        SET status = 'authorized', provider_ref = $2, provider_data = $3, updated_at = now()
      WHERE id = $1 AND status = 'pending' AND expires_at > now()
      RETURNING *`,
    [id, providerRef, JSON.stringify(providerData)],
  );
  return rows[0] ? toIntent(rows[0]) : null;
}

/**
 * Record that the money really moved and the orders exist.
 *
 * Guarded on `authorized` for the same reason as above, and it is the guard that makes a repeated
 * capture impossible from this side: Hyp document no idempotency key on their capture call
 * (`payment-hyp.ts` header), so ours is the only one there is.
 */
export async function markSettled(id: string): Promise<PaymentIntent | null> {
  const { rows } = await getDatabase().query<IntentRow>(
    `UPDATE payment_intents SET status = 'settled', updated_at = now()
      WHERE id = $1 AND status = 'authorized' RETURNING *`,
    [id],
  );
  return rows[0] ? toIntent(rows[0]) : null;
}

/** A decline, a void, or a capture that failed. Terminal, and deliberately reachable from either
 *  live status: money can fall over before the hold exists or after it does. */
export async function markFailed(id: string, reason: string): Promise<void> {
  await getDatabase().query(
    `UPDATE payment_intents
        SET status = 'failed',
            provider_data = COALESCE(provider_data, '{}'::jsonb) || jsonb_build_object('failure', $2::text),
            updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'authorized')`,
    [id, reason],
  );
}

/**
 * Abandoned intents, swept.
 *
 * **Only `pending` ones, and that limit is the whole safety of this function.** An `authorized`
 * intent names a hold on a real person's card; expiring it here would mark our own record dead
 * while the money stays reserved at the provider, with nothing left pointing at it. Those need a
 * void, which is a different job with a different failure mode — this one only cleans up buyers who
 * opened a payment page and walked away.
 *
 * Returns the swept rows rather than a count, because their snapshots are what a caller needs in
 * order to put the stock back.
 */
export async function expireAbandonedIntents(limit = 100): Promise<PaymentIntent[]> {
  const { rows } = await getDatabase().query<IntentRow>(
    `UPDATE payment_intents SET status = 'expired', updated_at = now()
      WHERE id IN (
        SELECT id FROM payment_intents
         WHERE status = 'pending' AND expires_at <= now()
         ORDER BY expires_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
  return rows.map(toIntent);
}
