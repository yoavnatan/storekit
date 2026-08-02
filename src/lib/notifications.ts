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

export type NotificationType = 'new_message' | 'seller_reply' | 'new_order' | 'order_update' | 'low_stock' | 'out_of_stock' | 'admin_message';
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
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
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
     RETURNING id, user_id, role, type, title, body, read, related_id, store_slug, store_name, created_at`,
    [
      id, input.userId, input.role, input.type, input.title ?? '', input.body ?? '',
      input.relatedId ?? null, input.storeSlug ?? null, input.storeName ?? null,
    ],
  );
  return toNotification(written[0]!);
}

/**
 * A person's feed, newest first, capped at {@link FEED_LIMIT}.
 *
 * `since` is the poll cursor and it comes from the browser's `localStorage`, which means it can be
 * anything at all. A value Postgres cannot parse as a timestamp raises an error rather than
 * matching nothing, so it is validated here — and an unparseable cursor is IGNORED rather than
 * treated as "nothing is newer". Hiding the feed behind a corrupt cursor would be permanent (the
 * client only ever rewrites it from a returned row); ignoring it costs one repeated toast and heals
 * itself on the next poll.
 */
export async function getNotificationsForUser(userId: string, since?: string): Promise<Notification[]> {
  const cursor = since && Number.isFinite(Date.parse(since)) ? new Date(since).toISOString() : null;
  const found = await rows<NotificationRow>(
    `SELECT id, user_id, role, type, title, body, read, related_id, store_slug, store_name, created_at
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

export async function deleteNotification(id: string, userId: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const { rowCount } = await query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, userId]);
  return rowCount > 0;
}

export async function deleteAllNotificationsForUser(userId: string): Promise<void> {
  await query('DELETE FROM notifications WHERE user_id = $1', [userId]);
}
