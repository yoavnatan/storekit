import crypto from 'node:crypto';
import { isUuid, query, rows, type Queryable } from './db.js';

// Admin<->seller messages are subject-based threads, exactly like the
// buyer<->seller ones in messages.ts (CURRENT_TASK "סשן ד׳"): the admin opens
// a thread with a subject, the seller replies inside it. They used to be ONE
// flat per-seller conversation surfaced as a permanently pinned "הודעות
// מערכת" row in the seller's messages table — that row existed even for a
// seller who never got a system message, and unrelated notices (a block
// notice, a question, a policy change) all piled into the same bubble list.
// Thread identity = the root message's id (`replyToId ?? id`).
//
// **Moved to Postgres with `messages` and `notifications` (DB_MIGRATION_PLAN.md §8).** It had to
// travel with them: the seller's Messages tab merges these threads with buyer threads into ONE
// sorted, filtered, paginated list (`seller-messages-query.ts`), and every write here is paired
// with a notification. Half of that page in a table and half in a JSON file cannot be ordered
// against each other.
//
// **Thread identity in SQL is `id = $1 OR reply_to_id = $1`, not `COALESCE(reply_to_id, id) = $1`.**
// The two select the same rows; the first uses the primary key and `admin_messages_thread_idx`,
// while an expression over two columns can use neither. It also keeps the module's one deliberate
// tolerance intact — a reply whose root was deleted is still reachable by the dead root's id, and
// `groupAdminThreads` still renders it as a thread of its own rather than dropping it.
export interface AdminMessage {
  id: string;
  sellerId: string;
  fromRole: 'admin' | 'seller';
  content: string;
  subject?: string;    // root message only
  replyToId?: string;  // reply -> root message id
  readByAdmin: boolean;
  readBySeller: boolean;
  createdAt: string;
}

// Pre-thread rows (and any row whose root was removed) carry no subject —
// they still render as a thread of their own rather than disappearing.
export const DEFAULT_ADMIN_SUBJECT = 'הודעת מערכת';

// Size caps, enforced by BOTH message APIs. The compose form's own
// maxlength is a convenience for the admin, not a control — a seller's
// reply reaches the same store over a plain fetch, so the limit has to
// live server-side to mean anything.
//
// Re-exported from messages.ts rather than declared again: "how big a message on this platform may
// be" is one rule, and two modules each holding their own copy of it is the shape that drifts.
export {
  MAX_MESSAGE_SUBJECT_LEN as MAX_ADMIN_SUBJECT_LEN,
  MAX_MESSAGE_CONTENT_LEN as MAX_ADMIN_CONTENT_LEN,
} from './messages.js';

export interface AdminThread {
  id: string;              // = root message id
  sellerId: string;
  subject: string;
  root: AdminMessage;
  messages: AdminMessage[]; // root first, then replies, chronological
  lastMessage: AdminMessage;
  unreadForAdmin: number;
  unreadForSeller: number;
}

const SELECT_ADMIN_MESSAGE = `SELECT id, seller_id, from_role, subject, content, reply_to_id,
                                     read_by_admin, read_by_seller, created_at
                                FROM admin_messages`;

interface AdminMessageRow {
  id: string;
  seller_id: string;
  from_role: string;
  subject: string | null;
  content: string;
  reply_to_id: string | null;
  read_by_admin: boolean;
  read_by_seller: boolean;
  created_at: Date | string;
}

function toAdminMessage(row: AdminMessageRow): AdminMessage {
  const message: AdminMessage = {
    id: row.id,
    sellerId: row.seller_id,
    fromRole: row.from_role as 'admin' | 'seller',
    content: row.content,
    readByAdmin: row.read_by_admin,
    readBySeller: row.read_by_seller,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
  if (row.subject !== null) message.subject = row.subject;
  if (row.reply_to_id) message.replyToId = row.reply_to_id;
  return message;
}

function threadIdOf(m: AdminMessage): string {
  return m.replyToId ?? m.id;
}

function runner(tx?: Queryable) {
  return tx ?? { query };
}

// `created_at, id` — rows written in one transaction share a timestamp to the microsecond, and
// grouping below relies on the oldest row of a group actually being first (§7.13).
const OLDEST_FIRST = 'ORDER BY created_at, id';

// Pure/exported separately from the read so it can be unit-tested
// without a database. Threads come out most-recently-active
// first — the order both inboxes (admin + seller) render in.
export function groupAdminThreads(messages: AdminMessage[]): AdminThread[] {
  const byThread = new Map<string, AdminMessage[]>();
  for (const m of messages) {
    const key = threadIdOf(m);
    const list = byThread.get(key) ?? [];
    list.push(m);
    byThread.set(key, list);
  }
  return [...byThread.entries()]
    .map(([id, msgs]) => {
      const sorted = [...msgs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      // A reply whose root was deleted still needs a root to render from —
      // fall back to the oldest message in the group rather than dropping it.
      const root = sorted.find((m) => m.id === id) ?? sorted[0]!;
      return {
        id,
        sellerId: root.sellerId,
        subject: root.subject?.trim() || DEFAULT_ADMIN_SUBJECT,
        root,
        messages: sorted,
        lastMessage: sorted[sorted.length - 1]!,
        unreadForAdmin: sorted.filter((m) => m.fromRole === 'seller' && !m.readByAdmin).length,
        unreadForSeller: sorted.filter((m) => m.fromRole === 'admin' && !m.readBySeller).length,
      };
    })
    .sort((a, b) => (a.lastMessage.createdAt < b.lastMessage.createdAt ? 1 : a.lastMessage.createdAt > b.lastMessage.createdAt ? -1 : 0));
}

/**
 * Every system thread on the platform — the admin's inbox.
 *
 * Unbounded on purpose for now, exactly as the file version was: this is the only screen that shows
 * them and it has no pagination yet. It joins `getAllOrders`/`getAllStores`/`getAllSellers`/
 * `getAllProducts` in the "returns everything" list of DB_MIGRATION_PLAN.md §3, which is scheduled
 * as one piece of work for all of them.
 */
export async function getAllAdminThreads(): Promise<AdminThread[]> {
  const found = await rows<AdminMessageRow>(`${SELECT_ADMIN_MESSAGE} ${OLDEST_FIRST}`);
  return groupAdminThreads(found.map(toAdminMessage));
}

export async function getAdminThreadsForSeller(sellerId: string): Promise<AdminThread[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<AdminMessageRow>(`${SELECT_ADMIN_MESSAGE} WHERE seller_id = $1 ${OLDEST_FIRST}`, [sellerId]);
  return groupAdminThreads(found.map(toAdminMessage));
}

export async function getAdminThreadById(threadId: string): Promise<AdminThread | null> {
  if (!isUuid(threadId)) return null;
  const found = await rows<AdminMessageRow>(
    `${SELECT_ADMIN_MESSAGE} WHERE id = $1 OR reply_to_id = $1 ${OLDEST_FIRST}`,
    [threadId],
  );
  if (found.length === 0) return null;
  return groupAdminThreads(found.map(toAdminMessage))[0] ?? null;
}

// Only the admin opens a thread — a seller never starts one (there is no
// "contact the platform" entry point by design; zero-touch self-service).
// The seller's reply inside an existing thread IS the appeal/response channel.
export async function createAdminThread(
  sellerId: string,
  subject: string,
  content: string,
  tx?: Queryable,
): Promise<AdminMessage> {
  const id = crypto.randomUUID();
  const { rows: written } = await runner(tx).query<AdminMessageRow>(
    `INSERT INTO admin_messages (id, seller_id, from_role, subject, content, read_by_admin, read_by_seller)
     VALUES ($1, $2, 'admin', $3, $4, true, false)
     RETURNING id, seller_id, from_role, subject, content, reply_to_id, read_by_admin, read_by_seller, created_at`,
    // read_by_admin is true above: the sender has obviously "seen" their own message.
    [id, sellerId, subject.trim() || DEFAULT_ADMIN_SUBJECT, content],
  );
  return toAdminMessage(written[0]!);
}

/**
 * Add a reply to an existing thread, or `null` when there is no such thread.
 *
 * The root is not read first and then written against — the `INSERT … SELECT` below reads it and
 * writes in one statement, so "the thread was deleted between the check and the write" cannot
 * happen and `sellerId` is taken from the root rather than trusted from the caller.
 */
export async function replyToAdminThread(
  threadId: string,
  fromRole: 'admin' | 'seller',
  content: string,
  tx?: Queryable,
): Promise<AdminMessage | null> {
  if (!isUuid(threadId)) return null;
  const { rows: written } = await runner(tx).query<AdminMessageRow>(
    `INSERT INTO admin_messages (id, seller_id, from_role, content, reply_to_id, read_by_admin, read_by_seller)
     SELECT $1, root.seller_id, $3::text, $4, $2, $3::text = 'admin', $3::text = 'seller'
       FROM admin_messages root
      WHERE root.id = $2
     RETURNING id, seller_id, from_role, subject, content, reply_to_id, read_by_admin, read_by_seller, created_at`,
    [crypto.randomUUID(), threadId, fromRole, content],
  );
  return written[0] ? toAdminMessage(written[0]) : null;
}

// Admin-only: removes the root and every reply under it, for BOTH sides.
// A system thread is the platform's own record (a block notice and the
// seller's appeal to it), so the seller can't delete one — only the admin,
// who owns that record, can. Returns false when the thread is already gone.
export async function deleteAdminThread(threadId: string, tx?: Queryable): Promise<boolean> {
  if (!isUuid(threadId)) return false;
  const { rowCount } = await runner(tx).query(
    'DELETE FROM admin_messages WHERE id = $1 OR reply_to_id = $1',
    [threadId],
  );
  return rowCount > 0;
}

export async function markAdminThreadReadByAdmin(threadId: string): Promise<void> {
  if (!isUuid(threadId)) return;
  await query(
    'UPDATE admin_messages SET read_by_admin = true WHERE (id = $1 OR reply_to_id = $1) AND NOT read_by_admin',
    [threadId],
  );
}

// sellerId is a guard, not a lookup — a seller may only mark their OWN
// thread read, so a forged threadId from another seller's inbox is a no-op.
export async function markAdminThreadReadBySeller(threadId: string, sellerId: string): Promise<void> {
  if (!isUuid(threadId) || !isUuid(sellerId)) return;
  await query(
    `UPDATE admin_messages SET read_by_seller = true
      WHERE (id = $1 OR reply_to_id = $1) AND seller_id = $2 AND NOT read_by_seller`,
    [threadId, sellerId],
  );
}

// Thread ids with at least one unread admin message — what the seller
// dashboard's live poll flags per row (it can no longer use a single count,
// now that system messages are many rows instead of one pinned one).
export async function getUnreadAdminThreadIdsForSeller(sellerId: string): Promise<string[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<{ thread_id: string }>(
    `SELECT DISTINCT COALESCE(reply_to_id, id) AS thread_id
       FROM admin_messages
      WHERE seller_id = $1 AND from_role = 'admin' AND NOT read_by_seller`,
    [sellerId],
  );
  return found.map((r) => r.thread_id);
}
