import crypto from 'node:crypto';
import { isUuid, query, rows } from './db.js';
import { BUSINESS_TIMEZONE, isDayISO } from './business-day.js';
import { searchClauses } from './moneylog-search.js';
import type { MoneyEventType } from './money-event-types.js';

// The vocabulary and its Hebrew labels live in `money-event-types.ts` — the SQL builder above needs
// them and this module needs the SQL builder, so the shared half is its own module rather than a
// cycle. Re-exported here because this has always been where the rest of the app imports them from.
export { MONEY_EVENT_TYPES, MONEY_EVENT_LABELS, moneyActorLabel, moneyEventStateWord, isMoneyEventType, type MoneyEventType } from './money-event-types.js';

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
  /** The seller this concerns, for events that belong to no single order or store — a payout spans
   *  an arbitrary set of both, and a clawback outlives the order it came from. Absent on the
   *  purchase-side events, which are identified by the three fields above. */
  sellerId?: string;
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
  seller_id: string | null;
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
  if (row.seller_id) event.sellerId = row.seller_id;
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
      `INSERT INTO money_events (id, at, type, order_id, checkout_ref, store_slug, seller_id,
                                 amount_agorot, from_value, to_value, actor, detail)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.id, entry.at, entry.type, entry.orderId ?? null, entry.checkoutRef ?? null,
        entry.storeSlug ?? null, entry.sellerId ?? null, entry.amountAgorot ?? null,
        entry.from ?? null, entry.to ?? null, entry.actor, entry.detail ?? null,
      ],
    );
  } catch {
    // Deliberately swallowed — see the header. The operation itself still stands.
  }
  return entry;
}

/** Always aliased `e`, in every query below and in `moneylog-search.ts`: the permalink rank joins
 *  this table to itself, where an unqualified `id` is ambiguous rather than merely untidy — and one
 *  spelling everywhere is what stops the two modules' fragments from only composing by luck. */
const EVENT_COLUMNS = `e.id, e.at, e.type, e.order_id, e.checkout_ref, e.store_slug, e.seller_id,
                       e.amount_agorot, e.from_value, e.to_value, e.actor, e.detail`;

/** The narrowing shared by every read here: the type filter, the business-day window, and the
 *  free-text search. Returns SQL fragments and appends their parameters to `params`, so the caller
 *  decides what to select and how to slice. */
function narrowingClauses(n: MoneyLogNarrowing, params: unknown[]): string {
  return [...windowClauses(n.type, n.from, n.to, params), ...searchClauses(n.q ?? '', params)].join(' AND ');
}

/** What the admin's toolbar narrows the journal by — the subset of `MoneyLogQuery`
 *  (admin-moneylog-filter.ts) that the database can answer. Declared here rather than imported so
 *  this module keeps depending on nothing that knows about URLs. */
export interface MoneyLogNarrowing {
  type?: MoneyEventType;
  q?: string;
  from?: string;
  to?: string;
}

/**
 * The narrowing every read of this journal shares, as SQL.
 *
 * **The date window is a half-open range on the RAW column, and that is the whole point.** It used
 * to read `(at AT TIME ZONE $tz)::date >= $from::date` — correct, and unable to use an index: a
 * function applied to the indexed column takes `money_events_at_idx` out of the plan and leaves a
 * sequential scan of the one table nothing is ever deleted from, so the money log got monotonically
 * slower for the life of the platform. Measured on the real journal (295 rows, 2026-08-07):
 * `Seq Scan … rows=295` before, `Index Scan using money_events_at_idx … Buffers: shared hit=3` after.
 * On a 300,000-row copy of it, which is where this actually matters: 149ms and 12,747 rows crossing
 * the network, against 17ms and 15 rows.
 *
 * Both forms mean the same window, and it is still the platform's business calendar (§7.8): each
 * BOUND is converted to an instant once, here, instead of every ROW being converted to a day. The
 * upper bound is the start of the day AFTER `to`, which is what makes it inclusive of `to` without
 * naming an end-of-day time that daylight saving can move.
 *
 * A bound that is not a real day is dropped rather than cast. Postgres RAISES on `2026-02-30`
 * instead of matching nothing, so without this an admin arriving on a hand-edited URL gets a 500
 * for the whole dashboard (business-day.ts#isDayISO). Callers reject it upstream too.
 */
function windowClauses(type: MoneyEventType | undefined, fromDay: string | undefined, toDay: string | undefined, params: unknown[]): string[] {
  const from = fromDay && isDayISO(fromDay) ? fromDay : null;
  const to = toDay && isDayISO(toDay) ? toDay : null;
  params.push(type ?? null, from, to, BUSINESS_TIMEZONE);
  const [t, f, u, tz] = [params.length - 3, params.length - 2, params.length - 1, params.length];
  return [
    `($${t}::text IS NULL OR e.type = $${t}::text)`,
    `($${f}::date IS NULL OR e.at >= ($${f}::date)::timestamp AT TIME ZONE $${tz}::text)`,
    `($${u}::date IS NULL OR e.at <  ($${u}::date + 1)::timestamp AT TIME ZONE $${tz}::text)`,
  ];
}

/** Newest-first read of the journal, narrowed to one type and/or a business-day window.
 *
 *  Kept for callers that genuinely want the whole window in memory — today only the tests and the
 *  parity guard. **The admin panel uses `getMoneyEventsPage`**, which adds the free-text search and
 *  a `LIMIT`; reading a window whole to display fifteen rows of it is the thing that was wrong here.
 *
 *  There is deliberately NO row cap: a cap would both make the panel's "N events" count describe the
 *  cap rather than the journal, and hide older rows of a filtered type behind newer rows of other
 *  types — which is exactly how the type filter came to look broken (it used to take the newest 500
 *  and narrow those). Narrowing therefore belongs HERE, ahead of any slicing a caller does. */
export async function getMoneyEvents(type?: MoneyEventType, fromDay?: string, toDay?: string): Promise<MoneyEvent[]> {
  const params: unknown[] = [];
  const where = windowClauses(type, fromDay, toDay, params).join(' AND ');
  const found = await rows<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM money_events e WHERE ${where} ORDER BY e.at DESC, e.id`,
    params,
  );
  return found.map(toEvent);
}

/**
 * One seller's rows of one STREAM, inside a business-day window — the fee report's source for the
 * monthly subscription charge.
 *
 * **Narrowed on two columns, never on `detail`.** The subscription charge is identified by
 * `seller_id` and by `from = SUBSCRIPTION_EVENT_STREAM` (`seller-subscription.ts`), because a
 * journal row's identity has to be a column: `detail` is a Hebrew sentence written for a person to
 * read, and a query pattern-matching it is a second definition of the row that a reword silently
 * breaks — on a money document.
 *
 * Reuses `windowClauses` so the window means exactly what it means everywhere else in this file,
 * index and business calendar included.
 */
export async function getSellerStreamEvents(
  sellerId: string,
  stream: string,
  fromDay?: string,
  toDay?: string,
): Promise<MoneyEvent[]> {
  if (!isUuid(sellerId)) return [];
  const params: unknown[] = [sellerId, stream];
  const where = windowClauses(undefined, fromDay, toDay, params).join(' AND ');
  const found = await rows<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM money_events e
      WHERE e.seller_id = $1 AND e.from_value = $2 AND ${where}
      ORDER BY e.at DESC, e.id`,
    params,
  );
  return found.map(toEvent);
}

/** One page of the journal, with the total behind it — everything the admin panel renders.
 *
 *  Narrowing, ordering, counting and slicing are ALL in the query. What used to happen instead:
 *  every row of the window travelled from Neon, was turned into objects, was filtered in JS, and
 *  fifteen of them were kept. The three costs that removes are the network transfer, the allocation,
 *  and the (terms × rows) scan on a single-threaded SSR server — none of which grows with anything
 *  the admin can see.
 *
 *  The total comes back with the page rather than from a second round trip: the pager needs the
 *  exact figure, and the database is over the network (~64ms a crossing regardless of the query).
 *
 *  **`LEFT JOIN … ON true`, not `count(*) OVER ()`**, and the difference is a real bug rather than a
 *  style choice: a window function has no row to ride on when the page is past the end of the
 *  result (a hand-typed `?mlpage=999`), so the total would come back as 0 and the pager would say
 *  the journal is empty. Joining the page ONTO the count always yields the count. */
export interface MoneyEventsPage {
  events: MoneyEvent[];
  /** Rows matching the narrowing, across all pages. */
  total: number;
}

export async function getMoneyEventsPage(
  narrowing: MoneyLogNarrowing,
  offset: number,
  limit: number,
): Promise<MoneyEventsPage> {
  const params: unknown[] = [];
  const where = narrowingClauses(narrowing, params);
  params.push(limit, offset);
  const found = await rows<Partial<EventRow> & { total_count: string | number }>(
    `WITH n AS (SELECT count(*) AS total_count FROM money_events e WHERE ${where}),
          p AS (SELECT ${EVENT_COLUMNS} FROM money_events e
                 WHERE ${where}
                 ORDER BY e.at DESC, e.id
                 LIMIT $${params.length - 1} OFFSET $${params.length})
     SELECT n.total_count, p.* FROM n LEFT JOIN p ON true`,
    params,
  );
  return {
    // A page past the end still returns the count row, with every event column NULL.
    events: found.filter((r) => r.id).map((r) => toEvent(r as EventRow)),
    // `count` is a bigint: a string from `pg`, a number from PGlite (§8).
    total: Number(found[0]?.total_count ?? 0),
  };
}

/** Which page of the current result set holds `eventId`, and whether it is in it at all — the
 *  answer to "open this link and show me that row", which no client can know: the row's page depends
 *  on the filters and on every row appended since the link was copied.
 *
 *  The rank is counted in SQL rather than by finding the row in a list, for the same reason the page
 *  is: the list no longer exists in memory. `ORDER BY at DESC, id` is a MIXED ordering, so "comes
 *  before" is spelled out rather than written as a row-value comparison, which would silently mean
 *  something else.
 *
 *  `null` = the row is not in this result set (wrong filter, or a journal that no longer has it),
 *  and the panel says so rather than silently showing page 1. */
export async function moneyEventPage(
  narrowing: MoneyLogNarrowing,
  eventId: string,
  pageSize: number,
): Promise<number | null> {
  // Postgres REJECTS a malformed uuid literal rather than simply not matching it, so a hand-edited
  // `?mev=nonsense` would be a 500 on the whole dashboard.
  if (!isUuid(eventId)) return null;
  const params: unknown[] = [eventId];
  const where = narrowingClauses(narrowing, params);
  // ONE round trip, not two: the rank and "is it even in this result set" are both needed before a
  // page can be chosen, and the database is over the network.
  const [found] = await rows<{ rank: string | number | null; present: boolean }>(
    `WITH target AS (SELECT at, id FROM money_events WHERE id = $1)
     SELECT
       (SELECT count(*) FROM money_events e, target t
         WHERE ${where} AND (e.at > t.at OR (e.at = t.at AND e.id < t.id))) AS rank,
       EXISTS (SELECT 1 FROM money_events e WHERE e.id = $1 AND ${where}) AS present`,
    params,
  );
  // The row itself must be inside the narrowing, not merely newer than rows that are: a `?mev=` to
  // an event the current filter excludes has to report itself missing rather than land on page 1.
  if (!found?.present) return null;
  return Math.floor(Number(found.rank ?? 0) / pageSize) + 1;
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
