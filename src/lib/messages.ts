import crypto from 'node:crypto';
import { isUuid, query, rows, type Queryable } from './db.js';
// Defined in a db-free module so the seller dashboard's client bundle can ask the same question
// without dragging a connection pool into the browser (`guest-sender.ts` says why).
export { GUEST_SENDER_PREFIX, senderHasAccount } from './guest-sender.js';

/**
 * Buyer ↔ seller conversations, on Postgres (DB_MIGRATION_PLAN.md §8).
 *
 * A "thread" here is a root message plus every row whose `replyToId` points at it — one level, no
 * nesting. That shape predates the database and is kept: the seller's inbox, the buyer's inbox, the
 * unread dots in the store switcher and the live poll all read it, and re-modelling it would have
 * been a second change riding along with the storage one.
 *
 * **Moved in the same diff as `notifications` and `admin-messages`, because a page reads all three
 * as one list.** Every write here is half of a pair — a message and the notification that tells its
 * recipient a message exists — and the seller's Messages tab merges buyer threads with the admin's
 * system threads, then sorts, filters and paginates ACROSS both (`seller-messages-query.ts`).
 * Splitting the move would have left one screen half in Postgres and half in a JSON file, ordered
 * over two sources that cannot be ordered together.
 *
 * **Three column facts decide most of the code below.**
 *
 * 1. `to_store_id` and `to_seller_id` are `uuid` with a foreign key, and the JSON file wrote
 *    whatever it was handed. 68 of the 72 stored rows — every reply — carry `toStoreId: ''`,
 *    because a reply is addressed to a person and not to a shop front. Postgres REJECTS `''` as a
 *    uuid literal, so a straight port would have turned every reply into a 500. Both columns are
 *    therefore resolved through a subselect on write: a value that is not the id of a real row
 *    lands as `NULL`, which is exactly what `scripts/lib/db-import.mjs` did to the same rows, and
 *    reads back as `''` so callers see the answer the file gave.
 *
 * 2. `from_user_id` is plain `text` on purpose (the schema says so): a guest id is not an account
 *    id, and imported rows carry pre-uuid ids like `u1`. It is never cast.
 *
 * 3. Replies are found by `reply_to_id`, so a reply whose recipient could not be resolved is still
 *    part of its thread and still renders. Nothing reads a reply BY `to_seller_id` except the
 *    seller-side unread predicates, and those only ever concern buyer→seller replies, which always
 *    carry a real seller id.
 *
 * **The N+1 that had to go.** Five call sites asked for one thread's replies inside a loop over
 * threads — both dashboards, the seller's AJAX pagination, the header's unread poll and the store
 * switcher's alert dots. Against a file behind an OS cache that was invisible; against a pool of
 * ten connections it is the shape that takes a page down. Two batch reads replace all five:
 * `getRepliesForMessages` for the render paths, and the `*UnreadThreadIds*` predicates below for
 * the ones that only need to know whether anything is waiting.
 */

const SELECT_MESSAGE = `SELECT id, from_user_id, from_name, from_email, to_store_id, to_seller_id,
                               to_store_name, subject, content, product_ref, reply_to_id,
                               read_by_seller, read_by_buyer, created_at
                          FROM messages`;

/**
 * How long a message may be, enforced by the SERVER.
 *
 * The compose form carries `maxlength="120"` and `maxlength="2000"`, and until 2026-08-02 those two
 * attributes were the only rule there was — a plain `fetch` reaches the same endpoint, and the reply
 * boxes have no attribute at all. This is the same lesson `MAX_CATEGORY_NAME_LENGTH` taught during
 * the categories move: a limit that lives in the markup is a convenience for the person using the
 * form, never a control. The content cap is above the form's own 2000 so nothing that works today
 * starts failing, and `admin-messages.ts` re-exports both rather than keeping a second copy — one
 * number for "how big a message on this platform may be".
 */
export const MAX_MESSAGE_SUBJECT_LEN = 120;
export const MAX_MESSAGE_CONTENT_LEN = 5000;

export interface MessageProductRef {
  productId: string;
  productName: string;
  productSlug: string;
  storeSlug: string;
}

/** How long any one field of the attached product reference may be. */
const MAX_PRODUCT_REF_FIELD_LEN = 200;

/**
 * The product a message is about, as the request claimed it — reduced to four short strings.
 *
 * This lands in a `jsonb` column straight off the wire and comes back out as a product name and a
 * site-relative link in the seller's inbox, so it gets the same treatment as any other request body:
 * exactly the four fields the type declares, each trimmed and bounded, and nothing at all when the
 * value is not an object. Without it the column takes whatever JSON was posted, at whatever size.
 */
function normalizeProductRef(value: unknown): MessageProductRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const field = (key: string): string =>
    (typeof raw[key] === 'string' ? raw[key] : '').trim().slice(0, MAX_PRODUCT_REF_FIELD_LEN);
  const ref: MessageProductRef = {
    productId: field('productId'),
    productName: field('productName'),
    productSlug: field('productSlug'),
    storeSlug: field('storeSlug'),
  };
  // An attachment with nothing identifying in it is noise, not a reference.
  return ref.productId || ref.productSlug ? ref : undefined;
}

export interface Message {
  id: string;
  fromUserId: string;
  fromName: string;
  fromEmail: string;
  toStoreId: string;
  toSellerId: string;
  toStoreName: string;
  subject: string;
  content: string;
  productRef?: MessageProductRef;
  replyToId?: string;
  readBySeller: boolean;
  readByBuyer?: boolean;
  createdAt: string;
}

interface MessageRow {
  id: string;
  from_user_id: string;
  from_name: string;
  from_email: string;
  to_store_id: string | null;
  to_seller_id: string | null;
  to_store_name: string;
  subject: string;
  content: string;
  product_ref: MessageProductRef | null;
  reply_to_id: string | null;
  read_by_seller: boolean;
  read_by_buyer: boolean;
  created_at: Date | string;
}

function toMessage(row: MessageRow): Message {
  const message: Message = {
    id: row.id,
    fromUserId: row.from_user_id,
    fromName: row.from_name,
    fromEmail: row.from_email,
    // `NULL` reads back as `''` — the value the file held for every reply. Callers compare it to a
    // store id (`m.toStoreId === s.id`) and an empty string simply never matches, as before.
    toStoreId: row.to_store_id ?? '',
    toSellerId: row.to_seller_id ?? '',
    toStoreName: row.to_store_name,
    subject: row.subject,
    content: row.content,
    readBySeller: row.read_by_seller,
    readByBuyer: row.read_by_buyer,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
  if (row.product_ref) message.productRef = row.product_ref;
  if (row.reply_to_id) message.replyToId = row.reply_to_id;
  return message;
}

/** A uuid column value, or `null` — never a literal Postgres would refuse to parse. See header (1). */
function uuidOrNull(value: string | undefined): string | null {
  return value && isUuid(value) ? value : null;
}

/** One statement, on the caller's transaction when there is one. */
function runner(tx?: Queryable) {
  return tx ?? { query };
}

/**
 * Newest first, with `id` breaking the tie (§7.13). Two rows written in the same transaction share
 * a `created_at` to the microsecond, and without a stable tie-break an inbox reorders itself
 * between two loads of the same page.
 */
const NEWEST_FIRST = 'ORDER BY created_at DESC, id';

/**
 * Store one message.
 *
 * `tx` exists so the caller can write the message and its notification together: a message with no
 * notification leaves the recipient with no badge, a notification with no message leaves a
 * deep-link into nothing, and only a transaction rules both out.
 */
export async function createMessage(
  input: Omit<Message, 'id' | 'createdAt' | 'readBySeller'>,
  tx?: Queryable,
): Promise<Message> {
  const id = crypto.randomUUID();
  const productRef = normalizeProductRef(input.productRef);
  const { rows: written } = await runner(tx).query<MessageRow>(
    `INSERT INTO messages (id, from_user_id, from_name, from_email, to_store_id, to_seller_id,
                           to_store_name, subject, content, product_ref, reply_to_id,
                           read_by_seller, read_by_buyer)
     VALUES ($1, $2, $3, $4,
             (SELECT s.id FROM stores s WHERE s.id = $5::uuid),
             (SELECT a.id FROM sellers a WHERE a.id = $6::uuid),
             $7, $8, $9, $10::jsonb, $11::uuid, false, $12)
     RETURNING id, from_user_id, from_name, from_email, to_store_id, to_seller_id, to_store_name,
               subject, content, product_ref, reply_to_id, read_by_seller, read_by_buyer, created_at`,
    [
      id, input.fromUserId, input.fromName ?? '', input.fromEmail ?? '',
      uuidOrNull(input.toStoreId), uuidOrNull(input.toSellerId),
      input.toStoreName ?? '',
      // Clamped rather than refused: this is the last gate before the column, and the API above
      // already answers 400 for anything over the limit. A caller that reaches here over-long has a
      // bug of its own, and a truncated message is a better outcome than a failed write.
      (input.subject ?? '').slice(0, MAX_MESSAGE_SUBJECT_LEN),
      (input.content ?? '').slice(0, MAX_MESSAGE_CONTENT_LEN),
      productRef ? JSON.stringify(productRef) : null,
      uuidOrNull(input.replyToId),
      Boolean(input.readByBuyer),
    ],
  );
  return toMessage(written[0]!);
}

// `getMessagesByBuyer` / `getMessagesBySeller` were DELETED here (§3, 2026-08-03). They returned
// every message a person is party to, unbounded, and their only caller was the un-narrowed branch
// of `GET /api/messages` — which had no client of its own and is gone with them (see that route
// for why it was removed rather than paginated). Every surface that used to be served by them
// asks a narrower question: `getThreadRootsBy*` for an inbox, `getRepliesForMessages` for a
// thread's bubbles, `getUnreadThreadIdsFor*` for a badge.

/** The root messages this person opened, newest first — the buyer's inbox groups by thread. */
export async function getThreadRootsByBuyer(userId: string): Promise<Message[]> {
  const found = await rows<MessageRow>(
    `${SELECT_MESSAGE} WHERE from_user_id = $1 AND reply_to_id IS NULL ${NEWEST_FIRST}`,
    [userId],
  );
  return found.map(toMessage);
}

/**
 * The root messages of one seller's threads, newest first — optionally narrowed to one store.
 *
 * The seller's inbox groups by thread, so it wants roots and then their replies in one batch; the
 * old code took every row and filtered `!m.replyToId` in memory, which read every reply twice.
 */
export async function getThreadRootsBySeller(sellerId: string, storeId?: string): Promise<Message[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<MessageRow>(
    `${SELECT_MESSAGE}
      WHERE to_seller_id = $1 AND reply_to_id IS NULL
        AND ($2::uuid IS NULL OR to_store_id = $2::uuid)
      ${NEWEST_FIRST}`,
    [sellerId, uuidOrNull(storeId)],
  );
  return found.map(toMessage);
}

/**
 * Mark a whole thread read by the seller it belongs to.
 *
 * `sellerId` is a guard rather than a lookup — an id from a request proves which account is asking,
 * never which thread it may touch, so a forged root id out of another seller's inbox is a no-op
 * here rather than a write.
 */
export async function markThreadReadBySeller(originalId: string, sellerId: string): Promise<void> {
  if (!isUuid(originalId) || !isUuid(sellerId)) return;
  await query(
    `UPDATE messages SET read_by_seller = true
      WHERE (id = $1 OR reply_to_id = $1) AND to_seller_id = $2 AND NOT read_by_seller`,
    [originalId, sellerId],
  );
}

/** One thread's replies, oldest first — the order the conversation was written in. */
export async function getMessageReplies(messageId: string): Promise<Message[]> {
  if (!isUuid(messageId)) return [];
  const found = await rows<MessageRow>(
    `${SELECT_MESSAGE} WHERE reply_to_id = $1 ORDER BY created_at, id`,
    [messageId],
  );
  return found.map(toMessage);
}

/**
 * The replies of MANY threads, in one statement — keyed by root id, each list oldest first.
 *
 * This is the batch that removes the N+1 (see header). Every root asked for gets a key, including
 * the ones with no replies, so a caller can index without a fallback and an empty thread is
 * distinguishable from a thread nobody asked about.
 */
export async function getRepliesForMessages(messageIds: readonly string[]): Promise<Record<string, Message[]>> {
  const ids = messageIds.filter(isUuid);
  const byRoot: Record<string, Message[]> = {};
  for (const id of messageIds) byRoot[id] = [];
  if (ids.length === 0) return byRoot;
  const found = await rows<MessageRow>(
    `${SELECT_MESSAGE} WHERE reply_to_id = ANY($1::uuid[]) ORDER BY created_at, id`,
    [ids],
  );
  for (const row of found) {
    const list = byRoot[row.reply_to_id!] ?? [];
    list.push(toMessage(row));
    byRoot[row.reply_to_id!] = list;
  }
  return byRoot;
}

export async function getMessageById(id: string): Promise<Message | null> {
  if (!isUuid(id)) return null;
  const found = await rows<MessageRow>(`${SELECT_MESSAGE} WHERE id = $1`, [id]);
  return found[0] ? toMessage(found[0]) : null;
}

/**
 * Mark a whole thread read by the buyer who opened it.
 *
 * `userId` is the same kind of guard as the seller's above, and it is NEW: the file version took
 * only a thread id and trusted it, so any signed-in account could clear the unread flags on any
 * conversation in the platform by posting someone else's id. The rule is the repo's standing one —
 * a session proves who is asking, never what they own, so every mutation by id is bound to its
 * owner in the statement itself.
 */
export async function markThreadReadByBuyer(originalId: string, userId: string): Promise<void> {
  if (!isUuid(originalId)) return;
  await query(
    `UPDATE messages SET read_by_buyer = true
      WHERE (id = $1 OR reply_to_id = $1)
        AND EXISTS (SELECT 1 FROM messages root WHERE root.id = $1 AND root.from_user_id = $2)
        AND NOT read_by_buyer`,
    [originalId, userId],
  );
}

/**
 * Remove a root and every reply under it.
 *
 * `reply_to_id` carries no foreign key (a reply may outlive its root in imported data), so there is
 * no cascade to lean on — both halves are named explicitly. `false` means the thread was already
 * gone, which the API turns into a 404.
 */
export async function deleteMessageThread(messageId: string): Promise<boolean> {
  if (!isUuid(messageId)) return false;
  const { rowCount } = await query('DELETE FROM messages WHERE id = $1 OR reply_to_id = $1', [messageId]);
  return rowCount > 0;
}

/**
 * Thread ids with something the seller has not read — one statement instead of a read of every
 * message followed by a reply lookup per thread.
 *
 * "Unread" means the root itself, OR any reply addressed to this seller: a buyer's follow-up inside
 * a thread the seller already opened is new mail, and the root's own flag says nothing about it.
 * The same definition backs the store-switcher dots and the seller's inbox rows, which is why it
 * lives here once rather than in each of them.
 */
export async function getUnreadThreadIdsForSeller(sellerId: string, storeId?: string): Promise<string[]> {
  if (!isUuid(sellerId)) return [];
  const found = await rows<{ id: string }>(
    `SELECT m.id
       FROM messages m
      WHERE m.to_seller_id = $1
        AND m.reply_to_id IS NULL
        AND ($2::uuid IS NULL OR m.to_store_id = $2::uuid)
        AND (NOT m.read_by_seller
             OR EXISTS (SELECT 1 FROM messages r
                         WHERE r.reply_to_id = m.id AND r.to_seller_id = $1 AND NOT r.read_by_seller))
      ORDER BY m.created_at DESC, m.id`,
    [sellerId, uuidOrNull(storeId)],
  );
  return found.map((r) => r.id);
}

/**
 * Thread ids where a reply from the other side is waiting for the buyer.
 *
 * Only replies count: the buyer wrote the root, so it can never be unread news to them.
 */
export async function getUnreadThreadIdsForBuyer(userId: string): Promise<string[]> {
  const found = await rows<{ id: string }>(
    `SELECT m.id
       FROM messages m
      WHERE m.from_user_id = $1
        AND m.reply_to_id IS NULL
        AND EXISTS (SELECT 1 FROM messages r
                     WHERE r.reply_to_id = m.id AND r.from_user_id <> $1 AND NOT r.read_by_buyer)
      ORDER BY m.created_at DESC, m.id`,
    [userId],
  );
  return found.map((r) => r.id);
}

/**
 * Which of these stores have mail waiting for their seller — the store-switcher's dots, in one
 * statement for every store at once (`seller-alerts.ts`).
 */
export async function getStoreIdsWithUnreadMessages(sellerId: string, storeIds: readonly string[]): Promise<Set<string>> {
  const ids = storeIds.filter(isUuid);
  if (!isUuid(sellerId) || ids.length === 0) return new Set();
  const found = await rows<{ to_store_id: string }>(
    `SELECT DISTINCT m.to_store_id
       FROM messages m
      WHERE m.to_seller_id = $1
        AND m.reply_to_id IS NULL
        AND m.to_store_id = ANY($2::uuid[])
        AND (NOT m.read_by_seller
             OR EXISTS (SELECT 1 FROM messages r
                         WHERE r.reply_to_id = m.id AND r.to_seller_id = $1 AND NOT r.read_by_seller))`,
    [sellerId, ids],
  );
  return new Set(found.map((r) => r.to_store_id));
}
