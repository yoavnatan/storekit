import crypto from 'node:crypto';
import { isUuid, query, rows, type Queryable } from './db.js';

/**
 * The in-app notification feed — one row per thing a person should be told about.
 *
 * **Moved to Postgres with `messages` and `admin-messages` (DB_MIGRATION_PLAN.md §8).** Every
 * notification here is the second half of a write in one of those two modules, and the header's
 * unread badge is read on EVERY page load by every signed-in account. Both facts point the same
 * way: the badge is a `COUNT` against `notifications_user_idx` rather than a file read, and a
 * message and its notification are written inside one transaction so neither can exist alone.
 *
 * **`role` carries a CHECK constraint** (`'buyer'` or `'seller'`), which the JSON file did not. The
 * union type is what keeps callers inside it; there is no runtime widening here, because a value
 * outside the two is a bug that should surface rather than be stored.
 *
 * **`type` deliberately has no CHECK.** The union below is the vocabulary this deploy writes, but
 * the column is plain `text` so a row written by a newer deploy — or an older one, like the `order`
 * rows the import carries — still reads back and still renders. A feed that refuses to show an
 * entry it does not recognise is worse than one that shows it plainly.
 */

export type NotificationType = 'new_message' | 'seller_reply' | 'new_order' | 'order_update' | 'low_stock' | 'out_of_stock' | 'admin_message' | 'domain_status' | 'feed_status';
export type NotificationRole = 'buyer' | 'seller';

export interface Notification {
  id: string;
  userId: string;
  role: NotificationRole;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  relatedId?: string;
  storeSlug?: string;
  storeName?: string;
  createdAt: string;
}

interface NotificationRow {
  id: string;
  user_id: string;
  role: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  related_id: string | null;
  store_slug: string | null;
  store_name: string | null;
  created_at: Date | string;
}

/**
 * How many entries one poll may return.
 *
 * It is a `LIMIT` now rather than a `.slice()` after reading everything, which is the whole point:
 * the header polls this every 15 seconds per open tab, and the old shape read the entire file to
 * throw away all but the newest 50.
 */
const FEED_LIMIT = 50;

function toNotification(row: NotificationRow): Notification {
  const notification: Notification = {
    id: row.id,
    userId: row.user_id,
    role: row.role as NotificationRole,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    read: row.read,
    // A string is passed through UNTOUCHED — the queries below format it in SQL at microsecond
    // precision, and `new Date(s).toISOString()` here would truncate it straight back to
    // milliseconds, which is the whole bug (see getNotificationsForUser). A `Date` can only ever
    // have held milliseconds, so there is nothing to preserve on that branch.
    createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
  };
  if (row.related_id) notification.relatedId = row.related_id;
  if (row.store_slug) notification.storeSlug = row.store_slug;
  if (row.store_name) notification.storeName = row.store_name;
  return notification;
}

function runner(tx?: Queryable) {
  return tx ?? { query };
}

/**
 * Append one notification.
 *
 * `tx` lets the caller write it together with the message it announces (see `messages.ts`). Callers
 * for whom a missed badge must never fail the operation being announced — the checkout's
 * "you sold something", the order-status pipeline — attach their own `.catch()` at the call site,
 * where that trade-off is visible, rather than having this module swallow errors for everyone.
 */
export async function createNotification(
  input: Omit<Notification, 'id' | 'read' | 'createdAt'>,
  tx?: Queryable,
): Promise<Notification> {
  const id = crypto.randomUUID();
  const { rows: written } = await runner(tx).query<NotificationRow>(
    `INSERT INTO notifications (id, user_id, role, type, title, body, read, related_id, store_slug, store_name)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9)
     RETURNING id, user_id, role, type, title, body, read, related_id, store_slug, store_name,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
    [
      id, input.userId, input.role, input.type, input.title ?? '', input.body ?? '',
      input.relatedId ?? null, input.storeSlug ?? null, input.storeName ?? null,
    ],
  );
  return toNotification(written[0]!);
}

/**
 * A person's feed, newest first, capped at {@link FEED_LIMIT}, plus the cursor to poll with next.
 *
 * `since` is the poll cursor and it comes from the browser's `localStorage`, which means it can be
 * anything at all. A value Postgres cannot parse as a timestamp raises an error rather than
 * matching nothing, so it is validated here — and an unparseable cursor is IGNORED rather than
 * treated as "nothing is newer". Hiding the feed behind a corrupt cursor would be permanent (the
 * client only ever rewrites it from a returned row); ignoring it costs one repeated toast and heals
 * itself on the next poll.
 *
 * **The client polls with `notifications[0].createdAt`, so that field must not lose precision —
 * measured against the live database 2026-08-03, where it did, and it was a live bug.**
 * `created_at` is `timestamptz`, which Postgres keeps to the MICROSECOND; a JS `Date` holds
 * milliseconds, so building the field with `toISOString()` silently dropped the last three digits:
 * a real row stored at `…:09.503137Z` reached the browser as `…:09.503Z`. The client stored that
 * as its cursor, and `created_at > '…503Z'` is still TRUE for `…503137` — so the newest
 * notification came back on EVERY poll, forever. Inside one page the toast container's `shownKeys`
 * hid the repeat; a reload empties that set, so the seller was shown the same "new message" toast
 * on every single refresh.
 *
 * So `created_at` is formatted in SQL at full precision (`toNotification` passes a string through
 * untouched) rather than round-tripped through a `Date` that cannot hold it. It is still ISO-8601
 * and still `new Date()`-parseable; the extra digits are simply truncated by any reader that only
 * wants a date. Truncating the COMPARISON instead (`date_trunc('milliseconds', …)`) would have
 * re-introduced the tie this avoids. Same family as the `error_log` sequence in migration 0005: a
 * clock's resolution is not a fact about your data.
 */
/**
 * The `since` cursor on its way INTO the query — and the precision has to survive this direction
 * too, which is where the first attempt at the fix above still lost it.
 *
 * Two properties, and neither may be traded for the other:
 *   · **Postgres must never see a literal it cannot parse.** It RAISES rather than matching
 *     nothing, and this runs on every page load, so that is a 500 on the whole site.
 *   · **A cursor this module issued must come back byte-identical.** `new Date(since).toISOString()`
 *     satisfies the first property and destroys the second: it rounds `…503137Z` to `…503Z`, and a
 *     row is then forever newer than its own cursor.
 *
 * So: a cursor that is ALREADY the instant this module would produce keeps the caller's extra
 * precision, and anything else is normalised through `Date` exactly as before. The test is a prefix
 * comparison rather than a pattern — `…503Z` normalised is a prefix of `…503137Z` issued — which
 * keeps the shape-of-a-date question out of here entirely (`tests/day-iso.test.ts`: a day-shaped
 * string is not a day, and a hand-rolled copy of that check is how `9999-99-99` gets in).
 *
 * An unparseable cursor is IGNORED rather than treated as "nothing is newer": hiding the feed
 * behind a corrupt cursor would be permanent, since the client only rewrites it from a returned row.
 */
function normalizeCursor(since?: string): string | null {
  if (!since || !Number.isFinite(Date.parse(since))) return null;
  const millisecond = new Date(since).toISOString();
  return since.startsWith(millisecond.slice(0, -1)) ? since : millisecond;
}

export async function getNotificationsForUser(userId: string, since?: string): Promise<Notification[]> {
  const cursor = normalizeCursor(since);
  const found = await rows<NotificationRow>(
    `SELECT id, user_id, role, type, title, body, read, related_id, store_slug, store_name,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM notifications
      WHERE user_id = $1
        AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
      ORDER BY created_at DESC, id
      LIMIT ${FEED_LIMIT}`,
    [userId, cursor],
  );
  return found.map(toNotification);
}

/** The header badge — read on every page load, which is what `notifications_user_idx` is for. */
export async function getUnreadCountForUser(userId: string): Promise<number> {
  const found = await rows<{ count: number | string }>(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND NOT read',
    [userId],
  );
  // `COUNT` is `bigint`: a string from `pg`, a number from PGlite. One conversion at the boundary.
  return Number(found[0]?.count ?? 0);
}

/** The buyer dashboard's Messages-tab badge — replies from sellers only. */
export async function getUnreadSellerReplyCount(userId: string): Promise<number> {
  const found = await rows<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND type = 'seller_reply' AND NOT read",
    [userId],
  );
  return Number(found[0]?.count ?? 0);
}

/** `false` when this notification is not this person's — an id is not a permission. */
export async function markNotificationRead(id: string, userId: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query(
    'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rowCount > 0;
}

export async function markAllReadForUser(userId: string): Promise<void> {
  await query('UPDATE notifications SET read = true WHERE user_id = $1 AND NOT read', [userId]);
}

/**
 * Drop the notifications that pointed at these things — how a notification stops existing once the
 * event behind it has been dealt with (a thread opened, a stock alert resolved, a system thread
 * deleted). `related_id` is plain `text`: it holds order ids, product ids and thread ids alike, and
 * some of those are not uuids in imported rows.
 */
export async function deleteNotificationsByRelatedIds(
  relatedIds: readonly string[],
  userId: string,
  tx?: Queryable,
): Promise<void> {
  if (relatedIds.length === 0) return;
  await runner(tx).query(
    'DELETE FROM notifications WHERE user_id = $1 AND related_id = ANY($2::text[])',
    [userId, relatedIds],
  );
}

/**
 * Which of these `relatedId`s already carry a notification created since `sinceIso` — the "have I
 * already said this" check, in one query.
 *
 * A repeating job needs it. `merchant-status-check.ts` re-reads the same rejected products from
 * Google every hour until the seller fixes them, and re-announcing each one hourly is how a
 * notification bell becomes something people stop looking at. Rather than remembering what it sent
 * (a table, a migration, and a second source of truth), it asks what is already on the seller's
 * feed — the notification IS the record.
 *
 * Deliberately not scoped to one user: the caller has rejections spread across many sellers and
 * would otherwise pay a query per seller. `relatedId` is built by the caller to be unique per
 * (thing, reason), so a key cannot collide across users by construction.
 */
export async function existingNotificationRelatedIds(
  relatedIds: readonly string[],
  sinceIso: string,
): Promise<Set<string>> {
  const wanted = [...new Set(relatedIds)];
  if (!wanted.length) return new Set();
  const { rows } = await query<{ related_id: string }>(
    `SELECT DISTINCT related_id FROM notifications
      WHERE related_id = ANY($1::text[]) AND created_at >= $2`,
    [wanted, sinceIso],
  );
  return new Set(rows.map((row) => row.related_id));
}

export async function deleteNotification(id: string, userId: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, userId]);
  return rowCount > 0;
}

export async function deleteAllNotificationsForUser(userId: string): Promise<void> {
  await query('DELETE FROM notifications WHERE user_id = $1', [userId]);
}
