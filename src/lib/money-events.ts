import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Mutex } from './mutex.js';
import { roundMoney } from './money.js';

/**
 * Append-only journal of every event that moves, or claims to move, money.
 *
 * The order records tell you what things ARE. This tells you what HAPPENED, in
 * order, and it is the only artefact that survives a bug: an order whose status is
 * wrong shows one wrong value, but the journal shows the sequence that produced it —
 * who changed what, from which value to which, at what moment, and off the back of
 * which request. Without it, "the seller says this order was never cancelled" is
 * unanswerable; with it, it is a lookup.
 *
 * Rules that make it worth having:
 *   • APPEND ONLY. Nothing here is ever edited or deleted. A mistake is corrected by
 *     appending the correcting event, never by rewriting history — a journal that can
 *     be rewritten proves nothing.
 *   • Every entry records the amount and the before/after of whatever it changed, so
 *     a reader never has to re-derive it from data that has since moved on.
 *   • Writing to it must never break the operation it is recording. A journal write
 *     that throws would turn "we failed to log the charge" into "we failed to charge",
 *     which is strictly worse — so failures here are swallowed after being surfaced to
 *     the error log.
 *
 * JSON-file era, same as the rest of `data/` (AI_INSTRUCTIONS.md → Scalability): the
 * append is mutex-serialised so concurrent requests cannot interleave a
 * read-modify-write. After the DB migration this becomes an INSERT into an
 * append-only table and the mutex goes away — the exported signatures do not change.
 * See DB_MIGRATION_PLAN.md.
 */

const EVENTS_PATH = path.join(process.cwd(), 'data/money-events.json');
const writeLock = new Mutex();

export type MoneyEventType =
  /** A charge was attempted at the payment provider. `ok` says how it went. */
  | 'payment_attempted'
  /** An order row was created off the back of a successful charge. */
  | 'order_created'
  /** A repeat submit of an already-completed checkout was served from the ledger
   *  instead of being charged again (checkout-idempotency.ts). The absence of these
   *  is not proof of nothing happening — their PRESENCE is proof a double charge was
   *  caught, which is the thing worth being able to show. */
  | 'duplicate_checkout_blocked'
  /** paymentStatus moved (pending → paid, → failed, refunded later). */
  | 'payment_status_changed'
  /** shippingStatus moved — including the cancellation that takes an order out of
   *  every revenue sum while leaving paymentStatus at 'paid'. */
  | 'shipping_status_changed'
  /** A seller applied or changed a discount on their slice of an order. */
  | 'order_discount_changed';

export interface MoneyEvent {
  id: string;
  /** ISO instant. The business day is derived at read time (business-day.ts) so the
   *  stored value stays an unambiguous absolute moment. */
  at: string;
  type: MoneyEventType;
  /** Order this concerns, when there is one. Absent for a charge that failed before
   *  any order row existed. */
  orderId?: string;
  /** Ties the (possibly multi-store) orders of one checkout together. */
  checkoutRef?: string;
  storeSlug?: string;
  /** The amount at stake, ILS. For a status change this is the order's own total —
   *  what stops or starts counting as revenue because of this event. */
  amount?: number;
  /** What changed, for the status/discount events. */
  from?: string;
  to?: string;
  /** Who caused it: a seller id, 'buyer', 'admin', or 'system'. */
  actor: string;
  /** Free-form context — a payment ref, a provider error, the idempotency key. */
  detail?: string;
}

function readEvents(): MoneyEvent[] {
  try { return JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8')) as MoneyEvent[]; }
  catch { return []; }
}

/**
 * Append one event. Never throws: a failure to journal must not fail the operation
 * being journalled (see the header). Returns the event so a caller can log its id.
 */
export async function recordMoneyEvent(event: Omit<MoneyEvent, 'id' | 'at'>): Promise<MoneyEvent> {
  const entry: MoneyEvent = {
    ...event,
    ...(event.amount !== undefined ? { amount: roundMoney(event.amount) } : {}),
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
  };
  await writeLock.run(() => {
    try {
      const all = readEvents();
      all.push(entry);
      fs.writeFileSync(EVENTS_PATH, JSON.stringify(all, null, 2));
    } catch {
      // Deliberately swallowed — see the header. The operation itself still stands.
    }
  });
  return entry;
}

/** Newest-first read, capped. The whole file is read and sorted in memory — fine at
 *  journal scale today, an indexed `ORDER BY at DESC LIMIT n` after the migration.
 *
 *  Deliberately no per-order / per-store filter parameters: the admin panel reads the
 *  whole recent journal and narrows in the page. When a per-order timeline is actually
 *  built (the obvious next consumer — "what happened to this order" on a dispute), it
 *  is a filter on this result, not speculative query surface to maintain until then. */
export function getMoneyEvents(limit = 200): MoneyEvent[] {
  const rows = readEvents();
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return rows.slice(0, limit);
}
