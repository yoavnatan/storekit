import { beforeEach, describe, expect, it } from 'vitest';
import { getDatabase, query, setDatabase, type Database } from '../src/lib/db.js';
import {
  createMessage,
  deleteMessageThread,
  getMessageById,
  getMessageReplies,
  getMessagesByBuyer,
  getMessagesBySeller,
  getRepliesForMessages,
  getStoreIdsWithUnreadMessages,
  getThreadRootsByBuyer,
  getThreadRootsBySeller,
  getUnreadThreadIdsForBuyer,
  getUnreadThreadIdsForSeller,
  MAX_MESSAGE_CONTENT_LEN,
  MAX_MESSAGE_SUBJECT_LEN,
  markThreadReadByBuyer,
  markThreadReadBySeller,
} from '../src/lib/messages.js';

/**
 * Buyer ↔ seller messages, against a real Postgres — moved with `notifications` and
 * `admin-messages` (DB_MIGRATION_PLAN.md §8).
 *
 * **Nothing exercised this module's I/O before this file.** The only coverage in the repo was
 * `seller-messages-query.test.ts`, which builds `Message` objects by hand and tests the pure
 * row-shaping beneath the inbox. Not one test read or wrote a message, so a replacement that
 * returned an empty inbox for every account, lost every reply, or marked the wrong person's threads
 * read would have left the whole suite green.
 *
 * Each block below names the failure it exists to catch, because a test whose subject is "it works"
 * gets deleted the first time it is inconvenient.
 */

const SELLER = '11111111-1111-4111-8111-000000000001';
const OTHER_SELLER = '11111111-1111-4111-8111-000000000002';
const STORE = '22222222-2222-4222-8222-000000000001';
const OTHER_STORE = '22222222-2222-4222-8222-000000000002';
const BUYER = 'buyer-account-1';

function root(over: Partial<Parameters<typeof createMessage>[0]> = {}) {
  return createMessage({
    fromUserId: BUYER,
    fromName: 'קונה',
    fromEmail: 'buyer@example.test',
    toStoreId: STORE,
    toSellerId: SELLER,
    toStoreName: 'קרמיקה',
    subject: 'שאלה',
    content: 'יש במלאי?',
    ...over,
  });
}

/** A seller's reply: addressed to a person, so it carries no store — the shape that had to be fixed. */
function reply(rootId: string, over: Partial<Parameters<typeof createMessage>[0]> = {}) {
  return createMessage({
    fromUserId: SELLER,
    fromName: 'מוכר',
    fromEmail: 'seller@example.test',
    toStoreId: '',
    toSellerId: BUYER,
    toStoreName: 'קרמיקה',
    subject: 'Re: שאלה',
    content: 'כן',
    replyToId: rootId,
    ...over,
  });
}

beforeEach(async () => {
  await query('DELETE FROM messages');
});

describe('writing a message', () => {
  it('accepts a reply whose toStoreId is the empty string, instead of raising on the uuid', async () => {
    // 68 of the 72 stored rows carry `toStoreId: ''` — every reply ever written, because a reply is
    // addressed to a person and not to a shop front. `to_store_id` is a `uuid` column, and Postgres
    // REJECTS `''` as a literal rather than simply not matching it, so a straight port of the file
    // version turned every single reply into a 500.
    const opened = await root();
    const answer = await reply(opened.id);
    expect(answer.toStoreId).toBe('');
    expect(answer.replyToId).toBe(opened.id);
    expect((await getMessageById(answer.id))!.content).toBe('כן');
  });

  it('stores a recipient that does not exist as absent, rather than failing the write', async () => {
    // Both id columns carry foreign keys the JSON file did not. A seller replying to a buyer whose
    // account has since been deleted — or to one of the imported pre-uuid ids like `u1` — must
    // still be able to answer; the row keeps the conversation, and the recipient reads back empty.
    const opened = await root();
    const answer = await reply(opened.id, { toSellerId: 'u1' });
    expect(answer.toSellerId).toBe('');
    // It is still part of the thread, which is what the buyer's inbox reads it by.
    expect((await getMessageReplies(opened.id)).map((m) => m.id)).toEqual([answer.id]);
  });

  it('keeps every field it was given, and omits the optionals it was not', async () => {
    const productRef = { productId: 'p1', productName: 'אגרטל', productSlug: 'agartal', storeSlug: 'keramika' };
    const written = await root({ productRef });
    const read = (await getMessageById(written.id))!;
    expect(read.fromUserId).toBe(BUYER);
    expect(read.toStoreId).toBe(STORE);
    expect(read.toSellerId).toBe(SELLER);
    expect(read.subject).toBe('שאלה');
    expect(read.productRef).toEqual(productRef);
    expect(read.readBySeller).toBe(false);
    expect('replyToId' in read).toBe(false);
  });

  it('clamps an over-long subject and body at the column rather than storing them whole', async () => {
    // The compose form's `maxlength` is a courtesy to whoever is typing; a plain fetch never sees
    // it, and the reply boxes carry no attribute at all. The API answers 400 above this; the module
    // clamps, because a truncated message beats a failed write on the last gate before the column.
    const written = await root({ subject: 'א'.repeat(500), content: 'ב'.repeat(20_000) });
    expect(written.subject).toHaveLength(MAX_MESSAGE_SUBJECT_LEN);
    expect(written.content).toHaveLength(MAX_MESSAGE_CONTENT_LEN);
  });

  it('reduces the attached product reference to its four declared fields, bounded', async () => {
    // It lands in a `jsonb` column straight off the wire, so it gets the same treatment as any
    // other request body: exactly the declared fields, each trimmed and capped.
    const written = await root({
      productRef: {
        productId: 'p1', productName: ' אגרטל ', productSlug: 'agartal'.repeat(200), storeSlug: 'keramika',
        extra: 'x'.repeat(100_000),
      } as never,
    });
    const read = (await getMessageById(written.id))!;
    expect(Object.keys(read.productRef!).sort()).toEqual(['productId', 'productName', 'productSlug', 'storeSlug']);
    expect(read.productRef!.productName).toBe('אגרטל');
    expect(read.productRef!.productSlug.length).toBeLessThanOrEqual(200);
  });

  it('drops an attachment that identifies no product at all', async () => {
    expect(await root({ productRef: 'not an object' as never })).not.toHaveProperty('productRef');
    expect(await root({ productRef: { productName: 'רק שם' } as never })).not.toHaveProperty('productRef');
  });

  it('does not blow up on a malformed id from a stale link — it answers "no such message"', async () => {
    // The same rule the sellers and categories moves each learned: an id out of an old bookmark or
    // a cookie written before ids were uuids must stay a 404, not become a 500.
    expect(await getMessageById('message-7')).toBeNull();
    expect(await getMessageReplies('message-7')).toEqual([]);
    expect(await deleteMessageThread('message-7')).toBe(false);
  });
});

describe('reading an inbox', () => {
  it('gives the seller their own mail and nobody else’s', async () => {
    await root();
    await root({ toSellerId: OTHER_SELLER, toStoreId: OTHER_STORE, subject: 'לאחר' });
    const mine = await getMessagesBySeller(SELLER);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toBe('שאלה');
  });

  it('orders newest first, and breaks a shared timestamp on a stable key', async () => {
    // Two rows written inside one transaction share `created_at` to the microsecond (§7.13). With
    // no tie-break the inbox reorders itself between two loads of the same page.
    const a = await root({ subject: 'א' });
    const b = await root({ subject: 'ב' });
    await query('UPDATE messages SET created_at = $1', ['2026-03-01T10:00:00.000Z']);
    const once = (await getThreadRootsBySeller(SELLER)).map((m) => m.id);
    const twice = (await getThreadRootsBySeller(SELLER)).map((m) => m.id);
    expect(once).toEqual(twice);
    expect(new Set(once)).toEqual(new Set([a.id, b.id]));
  });

  it('narrows the seller’s roots to one store, and leaves replies out of the list', async () => {
    const here = await root();
    await reply(here.id);
    await root({ toStoreId: OTHER_STORE, subject: 'חנות אחרת' });
    const rows = await getThreadRootsBySeller(SELLER, STORE);
    expect(rows.map((m) => m.id)).toEqual([here.id]);
  });

  it('gives the buyer the threads they opened, newest first', async () => {
    const first = await root({ subject: 'ראשון' });
    await query('UPDATE messages SET created_at = $1 WHERE id = $2', ['2026-01-01T10:00:00.000Z', first.id]);
    const second = await root({ subject: 'שני' });
    await reply(second.id);
    expect((await getThreadRootsByBuyer(BUYER)).map((m) => m.id)).toEqual([second.id, first.id]);
    // The un-narrowed read still includes replies — /api/messages?role=buyer relies on that.
    expect(await getMessagesByBuyer(BUYER)).toHaveLength(2);
  });

  it('returns a thread’s replies oldest first — the order the conversation was written in', async () => {
    const opened = await root();
    const first = await reply(opened.id, { content: 'ראשונה' });
    await query('UPDATE messages SET created_at = $1 WHERE id = $2', ['2026-01-01T10:00:00.000Z', first.id]);
    const second = await reply(opened.id, { content: 'שנייה' });
    expect((await getMessageReplies(opened.id)).map((m) => m.id)).toEqual([first.id, second.id]);
  });
});

describe('the batch that replaced the N+1', () => {
  it('returns every asked-for root, including the ones with no replies at all', async () => {
    // Five call sites used to query once per thread. The batch has to key EVERY id it was handed,
    // or a caller indexing by root id silently reads `undefined` for a quiet conversation.
    const withReplies = await root({ subject: 'עם' });
    const quiet = await root({ subject: 'בלי' });
    await reply(withReplies.id, { content: 'א' });
    await reply(withReplies.id, { content: 'ב' });

    const batched = await getRepliesForMessages([withReplies.id, quiet.id]);
    expect(Object.keys(batched).sort()).toEqual([withReplies.id, quiet.id].sort());
    expect(batched[withReplies.id]).toHaveLength(2);
    expect(batched[quiet.id]).toEqual([]);
  });

  it('agrees exactly with the per-thread read it replaced', async () => {
    const opened = await root();
    await reply(opened.id, { content: 'א' });
    await reply(opened.id, { content: 'ב' });
    const batched = await getRepliesForMessages([opened.id]);
    expect(batched[opened.id]).toEqual(await getMessageReplies(opened.id));
  });

  it('survives a malformed id in the list without dropping the valid ones', async () => {
    const opened = await root();
    await reply(opened.id);
    const batched = await getRepliesForMessages(['message-7', opened.id]);
    expect(batched['message-7']).toEqual([]);
    expect(batched[opened.id]).toHaveLength(1);
  });

  it('asks nothing of the database for an empty list', async () => {
    const real = getDatabase();
    const refuse: Database = {
      query: () => { throw new Error('no query should have been issued'); },
      transaction: real.transaction, close: real.close,
    };
    setDatabase(refuse);
    try {
      expect(await getRepliesForMessages([])).toEqual({});
    } finally {
      setDatabase(real);
    }
  });
});

describe('read state, seller side', () => {
  it('marks a whole thread read — the root AND the replies addressed to that seller', async () => {
    const opened = await root();
    const buyerFollowUp = await createMessage({
      fromUserId: BUYER, fromName: 'קונה', fromEmail: 'b@x.test',
      toStoreId: '', toSellerId: SELLER, toStoreName: 'קרמיקה',
      subject: 'Re: שאלה', content: 'עוד שאלה', replyToId: opened.id,
    });
    await markThreadReadBySeller(opened.id, SELLER);
    expect((await getMessageById(opened.id))!.readBySeller).toBe(true);
    expect((await getMessageById(buyerFollowUp.id))!.readBySeller).toBe(true);
  });

  it('refuses a thread that belongs to a different seller — an id is not a permission', async () => {
    const opened = await root();
    await markThreadReadBySeller(opened.id, OTHER_SELLER);
    expect((await getMessageById(opened.id))!.readBySeller).toBe(false);
  });

  it('leaves another seller’s mail untouched when it marks a thread read', async () => {
    const mine = await root();
    const theirs = await root({ toSellerId: OTHER_SELLER, toStoreId: OTHER_STORE });
    await markThreadReadBySeller(mine.id, SELLER);
    expect((await getMessageById(theirs.id))!.readBySeller).toBe(false);
  });
});

describe('read state, buyer side', () => {
  it('marks the thread the buyer opened read', async () => {
    const opened = await root();
    const answer = await reply(opened.id);
    await markThreadReadByBuyer(opened.id, BUYER);
    expect((await getMessageById(answer.id))!.readByBuyer).toBe(true);
  });

  it('refuses a thread the caller did not open — the hole the file version had', async () => {
    // The file version took only a thread id and trusted it, so any signed-in account could clear
    // the unread flags on any conversation on the platform by posting somebody else's id.
    const opened = await root();
    const answer = await reply(opened.id);
    await markThreadReadByBuyer(opened.id, 'someone-else');
    expect((await getMessageById(answer.id))!.readByBuyer).toBe(false);
  });

  it('marks every reply in the thread, not just the newest', async () => {
    const opened = await root();
    const first = await reply(opened.id, { content: 'א' });
    const second = await reply(opened.id, { content: 'ב' });
    await markThreadReadByBuyer(opened.id, BUYER);
    expect((await getMessageById(first.id))!.readByBuyer).toBe(true);
    expect((await getMessageById(second.id))!.readByBuyer).toBe(true);
  });
});

describe('what is waiting — the predicate the dots and the polls share', () => {
  it('flags a thread the seller has not opened', async () => {
    const opened = await root();
    expect(await getUnreadThreadIdsForSeller(SELLER)).toEqual([opened.id]);
  });

  it('flags a READ thread that has an unanswered buyer follow-up', async () => {
    // The reason this rule cannot live in each caller: a follow-up inside an already-opened thread
    // is new mail, and the root's own flag says nothing about it.
    const opened = await root();
    await markThreadReadBySeller(opened.id, SELLER);
    expect(await getUnreadThreadIdsForSeller(SELLER)).toEqual([]);
    await createMessage({
      fromUserId: BUYER, fromName: 'קונה', fromEmail: 'b@x.test',
      toStoreId: '', toSellerId: SELLER, toStoreName: 'קרמיקה',
      subject: 'Re', content: 'עוד', replyToId: opened.id,
    });
    expect(await getUnreadThreadIdsForSeller(SELLER)).toEqual([opened.id]);
  });

  it('does not count the seller’s OWN reply as something waiting for them', async () => {
    const opened = await root();
    await markThreadReadBySeller(opened.id, SELLER);
    await reply(opened.id);
    expect(await getUnreadThreadIdsForSeller(SELLER)).toEqual([]);
  });

  it('narrows to one store when asked, and never leaks another store’s mail', async () => {
    const here = await root();
    await root({ toStoreId: OTHER_STORE, subject: 'אחרת' });
    expect(await getUnreadThreadIdsForSeller(SELLER, STORE)).toEqual([here.id]);
  });

  it('flags for the buyer only when the OTHER side has written', async () => {
    const opened = await root();
    expect(await getUnreadThreadIdsForBuyer(BUYER)).toEqual([]);   // their own message is not news
    await reply(opened.id);
    expect(await getUnreadThreadIdsForBuyer(BUYER)).toEqual([opened.id]);
    await markThreadReadByBuyer(opened.id, BUYER);
    expect(await getUnreadThreadIdsForBuyer(BUYER)).toEqual([]);
  });

  it('answers for every store at once — the store-switcher dots', async () => {
    await root();                                        // unread, store A
    const quiet = await root({ toStoreId: OTHER_STORE, toSellerId: SELLER, subject: 'שקטה' });
    await markThreadReadBySeller(quiet.id, SELLER);
    const flagged = await getStoreIdsWithUnreadMessages(SELLER, [STORE, OTHER_STORE]);
    expect([...flagged]).toEqual([STORE]);
  });

  it('agrees with the per-store predicate it replaced, follow-ups included', async () => {
    const opened = await root();
    await markThreadReadBySeller(opened.id, SELLER);
    expect([...await getStoreIdsWithUnreadMessages(SELLER, [STORE])]).toEqual([]);
    await createMessage({
      fromUserId: BUYER, fromName: 'קונה', fromEmail: 'b@x.test',
      toStoreId: '', toSellerId: SELLER, toStoreName: 'קרמיקה',
      subject: 'Re', content: 'עוד', replyToId: opened.id,
    });
    expect([...await getStoreIdsWithUnreadMessages(SELLER, [STORE])]).toEqual([STORE]);
  });
});

describe('deleting a thread', () => {
  it('takes the replies with it — there is no cascade to lean on', async () => {
    // `reply_to_id` deliberately carries no foreign key (a reply may outlive its root in imported
    // data), so the delete has to name both halves itself.
    const opened = await root();
    const answer = await reply(opened.id);
    expect(await deleteMessageThread(opened.id)).toBe(true);
    expect(await getMessageById(opened.id)).toBeNull();
    expect(await getMessageById(answer.id)).toBeNull();
  });

  it('reports false for a thread that is already gone', async () => {
    const opened = await root();
    await deleteMessageThread(opened.id);
    expect(await deleteMessageThread(opened.id)).toBe(false);
  });

  it('leaves other threads alone', async () => {
    const doomed = await root({ subject: 'למחיקה' });
    const kept = await root({ subject: 'נשארת' });
    await reply(kept.id);
    await deleteMessageThread(doomed.id);
    expect(await getMessagesBySeller(SELLER)).toHaveLength(1);
    expect((await getThreadRootsBySeller(SELLER))[0]!.id).toBe(kept.id);
  });
});
