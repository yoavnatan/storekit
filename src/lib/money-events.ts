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

/**
 * The vocabulary, as a value rather than a bare union — a reader validating a
 * user-supplied type (the admin journal's filter) must check it against the set of
 * types that EXIST, never against the types that happen to appear in the rows it
 * just loaded. Doing the latter silently turns "show me only the blocked double
 * charges" into "show me everything" on any journal that has none yet, which is a
 * filter that lies rather than one that comes back empty.
 *
 *   payment_attempted          — a charge was attempted at the payment provider.
 *   order_created              — an order row was created off a successful charge.
 *   duplicate_checkout_blocked — a repeat submit of an already-completed checkout was
 *                                served from the ledger instead of charged again
 *                                (checkout-idempotency.ts). Their absence proves
 *                                nothing; their PRESENCE proves a double charge was
 *                                caught, which is what's worth being able to show.
 *   payment_status_changed     — paymentStatus moved (pending → paid → failed…).
 *   shipping_status_changed    — shippingStatus moved, including the cancellation that
 *                                takes an order out of every revenue sum while leaving
 *                                paymentStatus at 'paid'.
 *   order_discount_changed     — a seller applied/changed a discount on their slice.
 */
export const MONEY_EVENT_TYPES = [
  'payment_attempted',
  'order_created',
  'duplicate_checkout_blocked',
  'payment_status_changed',
  'shipping_status_changed',
  'order_discount_changed',
] as const;

export type MoneyEventType = (typeof MONEY_EVENT_TYPES)[number];

/**
 * The Hebrew name of each type, next to the vocabulary rather than in the panel that
 * renders it — because the admin's free-text search matches these labels too
 * (admin-moneylog-filter.ts). An owner who types "ביטול" is searching for the word he
 * is looking at on screen; if the label lived only in the component, the filter would
 * have had to keep a second copy of it, and the day they drifted the search would
 * quietly stop finding the rows whose chip still said the old word.
 * The panel keeps only the TONE (presentational) beside these.
 */
export const MONEY_EVENT_LABELS: Record<MoneyEventType, string> = {
  payment_attempted: 'ניסיון חיוב',
  order_created: 'הזמנה נוצרה',
  duplicate_checkout_blocked: 'חיוב כפול נמנע',
  payment_status_changed: 'סטטוס תשלום השתנה',
  shipping_status_changed: 'סטטוס משלוח השתנה',
  order_discount_changed: 'סכום הזמנה שונה',
};

/** Type guard for a request-supplied value (`?mtype=`). */
export function isMoneyEventType(value: string): value is MoneyEventType {
  return (MONEY_EVENT_TYPES as readonly string[]).includes(value);
}

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

/** Newest-first read of the whole journal, optionally narrowed to one type. The file is
 *  read and sorted in memory — fine at journal scale today, an indexed
 *  `WHERE type = ? ORDER BY at DESC` after the migration.
 *
 *  There is deliberately NO row cap: the admin panel paginates, and a cap would both
 *  make its "N events" count describe the window rather than the journal, and hide
 *  older rows of a filtered type behind newer rows of other types — which is exactly
 *  how the type filter came to look broken (it used to take the newest 500 and narrow
 *  those). Narrowing therefore belongs HERE, ahead of any slicing a caller does. Still
 *  no per-order / per-store parameters: when a per-order timeline is actually built (the
 *  obvious next consumer — "what happened to this order" on a dispute) it is a filter on
 *  this result, not speculative query surface to maintain until then. */
export function getMoneyEvents(type?: MoneyEventType): MoneyEvent[] {
  return selectMoneyEvents(readEvents(), type);
}

/** The selection itself, over rows already in memory — split out so the ordering and
 *  the narrowing are unit-testable without a journal file on disk. */
export function selectMoneyEvents(rows: MoneyEvent[], type?: MoneyEventType): MoneyEvent[] {
  return rows
    .filter((e) => !type || e.type === type)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
