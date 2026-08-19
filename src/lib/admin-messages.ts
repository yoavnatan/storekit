import crypto from 'node:crypto';
import { isUuid, query, rows, type Queryable } from './db.js';
import type { AdminThreadQuery } from './admin-threads-query.js';

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
export type InquiryParty = 'seller' | 'buyer' | 'guest';
export type InquiryKind = 'fault' | 'content' | 'store' | 'question' | 'other';

export interface AdminMessage {
  id: string;
  /** '' when the counterparty has no seller account — a buyer or a guest. */
  sellerId: string;
  fromRole: 'admin' | InquiryParty;
  content: string;
  subject?: string;    // root message only
  replyToId?: string;  // reply -> root message id
  readByAdmin: boolean;
  readBySeller: boolean;
  createdAt: string;
  // ── Root-only, all of it captured server-side (migration 20260819_133924). A reply carries none
  //    of it: the thread's identity belongs to its root. ──
  partyRole?: InquiryParty;
  partyId?: string;
  partyName?: string;
  partyEmail?: string;
  aboutKind?: InquiryKind;
  /** Site-relative, already validated through `safe-redirect.ts` on the way in. */
  pageUrl?: string;
  storeSlug?: string;
  /** The published review this complaint is about — the panel renders it inline with its takedown
   *  button, so reading the complaint and acting on it are one screen (owner, 2026-08-19). */
  reviewId?: string;
  status?: 'open' | 'handled';
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
  /** '' for a buyer or a guest — they have no seller account. */
  sellerId: string;
  subject: string;
  root: AdminMessage;
  messages: AdminMessage[]; // root first, then replies, chronological
  lastMessage: AdminMessage;
  unreadForAdmin: number;
  unreadForSeller: number;
  /** Who the platform is talking to. Absent on the threads that predate the inbox merge, which are
   *  all admin→seller by construction — `partyOf` below is what turns that into an answer rather
   *  than leaving every caller to guess. */
  partyRole: InquiryParty;
  status: 'open' | 'handled';
}

/** The counterparty's role, with the pre-merge default made explicit in one place: a thread with no
 *  `party_role` was opened by the admin against a seller, because until 2026-08-19 that was the only
 *  thread that could exist. */
export function partyOf(root: AdminMessage): InquiryParty {
  return root.partyRole ?? 'seller';
}

const ADMIN_MESSAGE_COLUMNS = `id, seller_id, from_role, subject, content, reply_to_id,
                               read_by_admin, read_by_seller, created_at,
                               party_role, party_id, party_name, party_email,
                               about_kind, page_url, store_slug, review_id, status`;

const SELECT_ADMIN_MESSAGE = `SELECT ${ADMIN_MESSAGE_COLUMNS} FROM admin_messages`;

interface AdminMessageRow {
  id: string;
  seller_id: string | null;
  from_role: string;
  subject: string | null;
  content: string;
  reply_to_id: string | null;
  read_by_admin: boolean;
  read_by_seller: boolean;
  created_at: Date | string;
  party_role: string | null;
  party_id: string | null;
  party_name: string | null;
  party_email: string | null;
  about_kind: string | null;
  page_url: string | null;
  store_slug: string | null;
  review_id: string | null;
  status: string | null;
}

function toAdminMessage(row: AdminMessageRow): AdminMessage {
  const message: AdminMessage = {
    id: row.id,
    // `''` and not `null`: every existing caller compares this to a seller id, and a nullable field
    // would make each of them decide what "no seller" means. The same answer `messages.ts` gives
    // for its own unresolvable ids.
    sellerId: row.seller_id ?? '',
    fromRole: row.from_role as AdminMessage['fromRole'],
    content: row.content,
    readByAdmin: row.read_by_admin,
    readBySeller: row.read_by_seller,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
  if (row.subject !== null) message.subject = row.subject;
  if (row.reply_to_id) message.replyToId = row.reply_to_id;
  if (row.party_role) message.partyRole = row.party_role as InquiryParty;
  if (row.party_id) message.partyId = row.party_id;
  if (row.party_name) message.partyName = row.party_name;
  if (row.party_email) message.partyEmail = row.party_email;
  if (row.about_kind) message.aboutKind = row.about_kind as InquiryKind;
  if (row.page_url) message.pageUrl = row.page_url;
  if (row.store_slug) message.storeSlug = row.store_slug;
  if (row.review_id) message.reviewId = row.review_id;
  if (row.status) message.status = row.status as 'open' | 'handled';
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
        // **`!== 'admin'`, not `=== 'seller'`.** The counterparty can now be a buyer or a guest,
        // and a predicate naming one role stops counting the moment a second one exists — which is
        // the shape that would have made a guest's message land in the inbox and never light the
        // badge that says something is waiting.
        unreadForAdmin: sorted.filter((m) => m.fromRole !== 'admin' && !m.readByAdmin).length,
        unreadForSeller: sorted.filter((m) => m.fromRole === 'admin' && !m.readBySeller).length,
        partyRole: partyOf(root),
        status: root.status ?? 'open',
      };
    })
    .sort((a, b) => (a.lastMessage.createdAt < b.lastMessage.createdAt ? 1 : a.lastMessage.createdAt > b.lastMessage.createdAt ? -1 : 0));
}

/**
 * ONE page of the admin's inbox, plus the unread total (§3, 2026-08-03).
 *
 * This used to be `getAllAdminThreads()` — every system message on the platform, grouped in JS,
 * then filtered, sorted and sliced to fifteen threads. The narrowing has to happen at THREAD
 * level, not message level, which is why it runs in two statements rather than one: the first
 * decides which thread ids belong on this page (filter, sort, limit, and the unread total that
 * the tab badge shows), the second fetches those threads' messages, and `groupAdminThreads`
 * assembles them exactly as before.
 *
 * The sort keys are the two the toolbar offers (`admin-threads-query.ts`): most recent activity,
 * or unread-first-then-recent. `filterAndSortAdminThreads` stays as the pure twin — it is what
 * `tests/admin-messages.test.ts` drives without a database.
 */
export interface AdminThreadsPage {
  threads: AdminThread[];
  /** Threads matching the filter, before the page slice. */
  total: number;
  /** Threads that exist at all, ignoring the filter — "no conversations yet" and "none match this
   *  filter" are different screens, and a page slice cannot tell them apart. */
  totalUnfiltered: number;
  page: number;
  totalPages: number;
  /** Unread admin-side messages across EVERY thread, filtered or not — the tab's "(N)" badge,
   *  which must not change because a filter is open. */
  unreadForAdmin: number;
}

/** Thread identity, activity and unread counts, as one row per thread. `COALESCE(reply_to_id, id)`
 *  is the grouping key here — unlike a single-thread lookup, this cannot use the index either way,
 *  because it is asking about all of them. */
const THREAD_ROLLUP = `
  SELECT COALESCE(m.reply_to_id, m.id)                                         AS thread_id,
         MAX(m.created_at)                                                     AS last_at,
         COUNT(*) FILTER (WHERE m.from_role <> 'admin' AND NOT m.read_by_admin) AS unread_admin,
         -- The root's own facts, hoisted so the toolbar can narrow on them without a second pass.
         -- A MAX() FILTER over a group whose root is exactly one row IS that row's value; a reply
         -- carries NULL in all of these, so it cannot outvote its root.
         MAX(m.party_role)  FILTER (WHERE m.reply_to_id IS NULL)               AS party_role,
         MAX(m.status)      FILTER (WHERE m.reply_to_id IS NULL)               AS status,
         MAX(m.about_kind)  FILTER (WHERE m.reply_to_id IS NULL)               AS about_kind
    FROM admin_messages m
   GROUP BY COALESCE(m.reply_to_id, m.id)`;

export async function getAdminThreadsPage(
  query: AdminThreadQuery,
  page: number,
  pageSize: number,
): Promise<AdminThreadsPage> {
  const unreadFirst = query.sortCol === 'unread';
  // Two numbers over the WHOLE rollup: how many threads the filter leaves (the pager), and how
  // many unread messages exist regardless of it (the tab badge, which must not move because a
  // filter is open — the same rule the other tabs' "(N)" badges follow).
  // One narrowing expression, written once and spent three times below — the pager's total, the
  // id page, and nothing else. A second copy is how a filter comes to mean one thing to the list
  // and another to the count above it.
  //
  // The role default is stated in SQL exactly as `partyOf` states it in TypeScript: a thread with
  // no `party_role` predates the merge and is admin→seller by construction.
  const NARROW = `($1::boolean IS NOT TRUE OR unread_admin > 0)
              AND ($2::text = 'all' OR COALESCE(party_role, 'seller') = $2::text)
              AND ($3::text = 'all' OR COALESCE(status, 'open') = $3::text)`;
  const narrowArgs = [query.unreadOnly, query.role, query.status];

  const totals = await rows<{ total: string | number; every: string | number; unread_total: string | number }>(
    `WITH t AS (${THREAD_ROLLUP})
     SELECT COUNT(*) FILTER (WHERE ${NARROW}) AS total,
            COUNT(*)                          AS every,
            COALESCE(SUM(unread_admin), 0)    AS unread_total
       FROM t`,
    narrowArgs,
  );
  const total = Number(totals[0]?.total ?? 0);
  const totalUnfiltered = Number(totals[0]?.every ?? 0);
  const unreadForAdmin = Number(totals[0]?.unread_total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const ids = (await rows<{ thread_id: string }>(
    `WITH t AS (${THREAD_ROLLUP})
     SELECT thread_id FROM t
      WHERE ${NARROW}
      ORDER BY ${unreadFirst ? '(unread_admin > 0) DESC,' : ''} last_at DESC, thread_id
      LIMIT $4 OFFSET $5`,
    [...narrowArgs, pageSize, (safePage - 1) * pageSize],
  )).map((r) => r.thread_id);

  if (!ids.length) return { threads: [], total, totalUnfiltered, page: safePage, totalPages, unreadForAdmin };

  const found = await rows<AdminMessageRow>(
    `${SELECT_ADMIN_MESSAGE} WHERE COALESCE(reply_to_id, id) = ANY($1::uuid[]) ${OLDEST_FIRST}`,
    [ids],
  );
  // Grouped by the same function the single-thread reads use, then put back into the order the
  // query decided — `groupAdminThreads` sorts by recency, which is only one of the two sorts.
  const byId = new Map(groupAdminThreads(found.map(toAdminMessage)).map((t) => [t.id, t]));
  const threads = ids.map((id) => byId.get(id)).filter((t): t is AdminThread => Boolean(t));
  return { threads, total, totalUnfiltered, page: safePage, totalPages, unreadForAdmin };
}

// `getAllAdminThreads()` was DELETED here (§3, 2026-08-03) — every system message on the platform,
// with no bound. Both of its callers now ask for a page: the dashboard render and the Messages
// tab's poll, which is the same function with page 1 and the recency sort. An export with no
// caller is an export with no test, which is why four of them went the same way when this module
// moved to Postgres.

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

/**
 * The ADMIN opening a thread against a seller — a block notice, a policy change, a question.
 *
 * The other direction is `createInquiryThread` below. Until 2026-08-19 there was no other
 * direction: a seller could only reply inside a thread the admin had already opened, so a seller
 * with a question had no way in that stayed inside the product.
 */
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
     RETURNING ${ADMIN_MESSAGE_COLUMNS}`,
    // read_by_admin is true above: the sender has obviously "seen" their own message.
    [id, sellerId, subject.trim() || DEFAULT_ADMIN_SUBJECT, content],
  );
  return toAdminMessage(written[0]!);
}

/**
 * A PERSON opening a thread with the platform — the direction that did not exist until 2026-08-19.
 *
 * Everything the sender is trusted for is the two fields they typed: `subject` and `content`. Every
 * other column here is the caller's server-side finding, and that division is the whole point —
 * `user_reports` (migration 0025) stated it first and this inherits it verbatim: **the reporter
 * describes, the SERVER attributes.** A thread whose sender could name the store it is about, or
 * their own role, would be a way to point the admin at a competitor while claiming to be a buyer.
 *
 * `sellerId` is passed separately from `party.id` and is not the same thing: it is the typed,
 * foreign-keyed column the seller's own dashboard reads by, so it is set only when the counterparty
 * really has a seller account. A buyer's account id lives in `party.id` as text.
 *
 * Unread for the admin from the moment it is written — that is what the tab badge counts, and it is
 * why `read_by_admin` is false here and true in `createAdminThread`.
 */
export interface NewInquiry {
  subject: string;
  content: string;
  party: {
    role: InquiryParty;
    /** The seller's account id — and ONLY when the role is 'seller'. Anything else lands in
     *  `party_id`, so a buyer can never be read back as the owner of a store. */
    sellerId?: string;
    id?: string;
    name?: string;
    email?: string;
  };
  kind?: InquiryKind;
  /** Site-relative. The caller validates it (`safe-redirect.ts`) — this module stores what it is
   *  given, and the column's comment says why that must not be an absolute URL. */
  pageUrl?: string;
  storeSlug?: string;
  reviewId?: string;
}

export async function createInquiryThread(input: NewInquiry, tx?: Queryable): Promise<AdminMessage> {
  const sellerId = input.party.role === 'seller' && isUuid(input.party.sellerId ?? '')
    ? input.party.sellerId! : null;
  const { rows: written } = await runner(tx).query<AdminMessageRow>(
    `INSERT INTO admin_messages (id, seller_id, from_role, subject, content,
                                 read_by_admin, read_by_seller,
                                 party_role, party_id, party_name, party_email,
                                 about_kind, page_url, store_slug, review_id, status)
     VALUES ($1, $2, $3, $4, $5, false, true, $3, $6, $7, $8, $9, $10, $11, $12, 'open')
     RETURNING ${ADMIN_MESSAGE_COLUMNS}`,
    // `read_by_seller` is true: the sender has obviously seen their own message, and leaving it
    // false would put an unread dot on the seller's own dashboard for something they just wrote.
    [
      crypto.randomUUID(), sellerId, input.party.role,
      input.subject.trim() || DEFAULT_ADMIN_SUBJECT, input.content,
      input.party.id ?? null, input.party.name ?? null, input.party.email ?? null,
      input.kind ?? null, input.pageUrl ?? null, input.storeSlug ?? null,
      input.reviewId && isUuid(input.reviewId) ? input.reviewId : null,
    ],
  );
  return toAdminMessage(written[0]!);
}

/**
 * Mark a thread done, or reopen it.
 *
 * Separate from "read", and the distinction is the one the reports list had and the threads did
 * not: read is about attention, this is about the work. A thread the admin has opened, read and not
 * yet acted on is exactly the one that used to vanish from view.
 *
 * Written on the ROOT only — the root is the thread's identity everywhere else in this module, and
 * a status spread across replies is a status that can disagree with itself.
 */
export async function setAdminThreadStatus(threadId: string, handled: boolean): Promise<boolean> {
  if (!isUuid(threadId)) return false;
  const { rowCount } = await query(
    `UPDATE admin_messages
        SET status = $2, handled_at = CASE WHEN $2 = 'handled' THEN now() ELSE NULL END
      WHERE id = $1 AND reply_to_id IS NULL`,
    [threadId, handled ? 'handled' : 'open'],
  );
  return rowCount > 0;
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
  fromRole: 'admin' | InquiryParty,
  content: string,
  tx?: Queryable,
): Promise<AdminMessage | null> {
  if (!isUuid(threadId)) return null;
  const { rows: written } = await runner(tx).query<AdminMessageRow>(
    `INSERT INTO admin_messages (id, seller_id, from_role, content, reply_to_id, read_by_admin, read_by_seller)
     SELECT $1, root.seller_id, $3::text, $4, $2, $3::text = 'admin', $3::text <> 'admin'
       FROM admin_messages root
      WHERE root.id = $2
     RETURNING ${ADMIN_MESSAGE_COLUMNS}`,
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
