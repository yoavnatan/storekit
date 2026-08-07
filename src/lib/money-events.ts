import crypto from 'node:crypto';
import { isUuid, query, rows } from './db.js';
import { BUSINESS_TIMEZONE, isDayISO } from './business-day.js';

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
 * **Moved to Postgres with `orders` (DB_MIGRATION_PLAN.md §4/§8).** An append is now a single
 * `INSERT`, so the `Mutex` that serialised the old read-modify-write is gone with it — and with it
 * the ceiling it imposed: a mutex holds inside one node process, so two instances appending
 * concurrently would each read the file, each append their own entry, and each write back a file
 * missing the other's. A journal that loses entries under load is worse than no journal, because
 * it is still believed.
 *
 * It had to move in the same change as `orders` for the same reason `checkout-idempotency` did:
 * an order written to a table and its `order_created` entry written to a file are two systems that
 * can disagree, and the whole value of this file is being the record that survives when they do.
 *
 * The append-only rule is enforced at the ROLE level in production, not here — the schema comment
 * on `money_events` carries the `REVOKE UPDATE, DELETE` that makes it true (a GO_LIVE step, since
 * the role name is environment-specific). There is deliberately no `updateMoneyEvent` to grep for.
 */

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
 *   charge_voided              — a charge SUCCEEDED and the purchase behind it then failed, so
 *                                the money was given back (payment.ts#voidCharge). The most
 *                                important row in this journal when it exists: it is the only
 *                                trace that a buyer's card was touched for an order that does
 *                                not exist. A row whose detail says the void FAILED is money
 *                                owed back to a real person, and it pages someone.
 */
export const MONEY_EVENT_TYPES = [
  'payment_attempted',
  'order_created',
  'charge_voided',
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
  charge_voided: 'חיוב בוטל',
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
  /** The amount at stake, in integer agorot (§7.7 — the unit flipped with `orders`; see that
   *  module's header for why the field was RENAMED rather than reinterpreted). For a status change
   *  this is the order's own total — what stops or starts counting as revenue because of it. */
  amountAgorot?: number;
  /** What changed, for the status/discount events. */
  from?: string;
  to?: string;
  /** Who caused it: a seller id, 'buyer', 'admin', or 'system'. */
  actor: string;
  /** Free-form context — a payment ref, a provider error, the idempotency key. */
  detail?: string;
}

interface EventRow {
  id: string;
  at: Date | string;
  type: string;
  order_id: string | null;
  checkout_ref: string | null;
  store_slug: string | null;
  amount_agorot: string | number | null;
  from_value: string | null;
  to_value: string | null;
  actor: string;
  detail: string | null;
}

function toEvent(row: EventRow): MoneyEvent {
  const event: MoneyEvent = {
    id: row.id,
    at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString(),
    // The column is plain `text` — a journal must be able to record an event of a type this
    // deploy has never heard of rather than refuse to show the row. Callers that care narrow by
    // `MONEY_EVENT_TYPES`, which is why that list is a value and not a bare union.
    type: row.type as MoneyEventType,
    actor: row.actor,
  };
  if (row.order_id) event.orderId = row.order_id;
  if (row.checkout_ref) event.checkoutRef = row.checkout_ref;
  if (row.store_slug) event.storeSlug = row.store_slug;
  // `bigint` comes back from `pg` as a string and from PGlite as a number; untouched, the admin's
  // free-text search would match '1250' one way and 1250 the other.
  if (row.amount_agorot !== null && row.amount_agorot !== undefined) {
    const n = Number(row.amount_agorot);
    if (Number.isFinite(n)) event.amountAgorot = n;
  }
  if (row.from_value !== null) event.from = row.from_value;
  if (row.to_value !== null) event.to = row.to_value;
  if (row.detail) event.detail = row.detail;
  return event;
}

/**
 * Append one event. Never throws: a failure to journal must not fail the operation
 * being journalled (see the header). Returns the event so a caller can log its id.
 */
export async function recordMoneyEvent(event: Omit<MoneyEvent, 'id' | 'at'>): Promise<MoneyEvent> {
  const entry: MoneyEvent = {
    ...event,
    // Agorot are integers by definition; a caller handing over a fraction means a bug upstream,
    // and rounding it here keeps the row writable rather than turning the journal write into the
    // thing that fails the charge it was recording.
    ...(event.amountAgorot !== undefined ? { amountAgorot: Math.round(event.amountAgorot) } : {}),
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
  };
  try {
    await query(
      `INSERT INTO money_events (id, at, type, order_id, checkout_ref, store_slug,
                                 amount_agorot, from_value, to_value, actor, detail)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.id, entry.at, entry.type, entry.orderId ?? null, entry.checkoutRef ?? null,
        entry.storeSlug ?? null, entry.amountAgorot ?? null, entry.from ?? null, entry.to ?? null,
        entry.actor, entry.detail ?? null,
      ],
    );
  } catch {
    // Deliberately swallowed — see the header. The operation itself still stands.
  }
  return entry;
}

/** Newest-first read of the journal, narrowed to one type and/or a business-day window.
 *
 *  Both narrowings are pushed into SQL. The type one has to be (see below); the DAY one is here
 *  because the journal is the one table nothing is ever deleted from, so "the admin opened the
 *  money log" must not mean "read every event ever recorded". The window is expressed in the
 *  platform's business calendar (§7.8) — `AT TIME ZONE 'Asia/Jerusalem'`, the same conversion
 *  `business-day.ts` does in JS, so a row found by searching a date here is the row the seller's
 *  chart counts on that day. UTC would move the boundary by two or three hours and silently file
 *  every after-midnight event under the wrong day on both screens.
 *
 *  There is deliberately NO row cap: the admin panel paginates, and a cap would both
 *  make its "N events" count describe the window rather than the journal, and hide
 *  older rows of a filtered type behind newer rows of other types — which is exactly
 *  how the type filter came to look broken (it used to take the newest 500 and narrow
 *  those). Narrowing therefore belongs HERE, ahead of any slicing a caller does.
 *
 *  Free-text search stays in memory over the result, in `admin-moneylog-filter.ts`: it matches
 *  the Hebrew LABEL of a type as well as the stored columns, and the labels do not exist in the
 *  database. The trigram indexes (0001/0004) are what a future pushdown of the column half would
 *  use. */
export async function getMoneyEvents(type?: MoneyEventType, fromDay?: string, toDay?: string): Promise<MoneyEvent[]> {
  // A bound that is not a real day is dropped rather than cast. Postgres RAISES on `2026-02-30`
  // instead of matching nothing, so without this an admin arriving on a hand-edited URL gets a 500
  // for the whole dashboard (business-day.ts#isDayISO). Callers reject it upstream too.
  const from = fromDay && isDayISO(fromDay) ? fromDay : null;
  const to = toDay && isDayISO(toDay) ? toDay : null;
  const found = await rows<EventRow>(
    `SELECT id, at, type, order_id, checkout_ref, store_slug, amount_agorot,
            from_value, to_value, actor, detail
       FROM money_events
      WHERE ($1::text IS NULL OR type = $1::text)
        AND ($2::date IS NULL OR (at AT TIME ZONE $4::text)::date >= $2::date)
        AND ($3::date IS NULL OR (at AT TIME ZONE $4::text)::date <= $3::date)
      ORDER BY at DESC, id`,
    [type ?? null, from, to, BUSINESS_TIMEZONE],
  );
  return found.map(toEvent);
}

/**
 * The business day one event landed on, or `null` when there is no such row.
 *
 * One value, so that a `?mev=` permalink can widen the journal's default window back to the row it
 * names (`admin-moneylog-filter.ts#widenToEvent`) instead of reporting it missing. The day is
 * computed in SQL, in the platform's calendar, for the same reason the window itself is: a link
 * resolved on one calendar and filtered on another lands one row off at the boundary.
 *
 * `id` is checked for shape first — Postgres REJECTS a malformed uuid literal rather than simply
 * not matching it, so a hand-edited `?mev=nonsense` would be a 500 on the whole dashboard.
 */
export async function getMoneyEventDay(eventId: string): Promise<string | null> {
  if (!isUuid(eventId)) return null;
  const found = await rows<{ day: string }>(
    `SELECT to_char(at AT TIME ZONE $2::text, 'YYYY-MM-DD') AS day FROM money_events WHERE id = $1`,
    [eventId, BUSINESS_TIMEZONE],
  );
  return found[0]?.day ?? null;
}

/** The selection itself, over rows already in memory — split out so the ordering and the
 *  narrowing are unit-testable without a database, and kept in step with the query above
 *  DELIBERATELY: two events appended inside one transaction share an `at` to the microsecond, so
 *  without the `id` tie-break the pair swaps places between two loads of the same page. */
export function selectMoneyEvents(events: MoneyEvent[], type?: MoneyEventType): MoneyEvent[] {
  return events
    .filter((e) => !type || e.type === type)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
