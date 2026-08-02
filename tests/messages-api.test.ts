import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/lib/db.js';
import { createMessage, MAX_MESSAGE_CONTENT_LEN, MAX_MESSAGE_SUBJECT_LEN } from '../src/lib/messages.js';

/**
 * `/api/messages`, against a real Postgres and the real modules beneath it.
 *
 * Only the SESSION is stubbed — everything else is the genuine article, because the three things
 * this file exists to hold are all decided at the route: who a message is delivered to, who may
 * read a conversation, and how big one may be. A mocked `messages.js` would have tested the mock.
 *
 * All three were found by the repo's own review checklist during the messaging move (2026-08-02),
 * and all three predate it: the file-backed version had the same holes and no test would have said so.
 */

const SELLER = '11111111-1111-4111-8111-000000000001';
const OTHER_SELLER = '11111111-1111-4111-8111-000000000002';
const STORE = '22222222-2222-4222-8222-000000000001';
const BUYER = 'buyer-account-1';

let session: string | null = SELLER;

vi.mock('../src/lib/seller-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/seller-auth.js')>()),
  getSellerSession: () => session,
}));

const { GET, POST } = await import('../src/pages/api/messages.js');

const cookies = {} as never;

function get(qs: string) {
  return GET({ request: new Request(`https://x.test/api/messages${qs}`), cookies } as never) as Promise<Response>;
}
function post(body: unknown) {
  return POST({
    request: new Request('https://x.test/api/messages', { method: 'POST', body: JSON.stringify(body) }),
    cookies,
  } as never) as Promise<Response>;
}

beforeEach(async () => {
  await query('DELETE FROM messages');
  await query('DELETE FROM notifications');
  session = SELLER;
});

describe('who a message is delivered to', () => {
  it('takes the seller and the shop name from the STORE, not from the request body', async () => {
    // The body used to carry `toSellerId` and `toStoreName` beside the store id, so a hand-made post
    // could file a message under one shop's name and deliver it to a different seller entirely.
    const res = await post({
      toStoreId: STORE,
      toSellerId: OTHER_SELLER,          // ignored
      toStoreName: 'חנות שלא קיימת',      // ignored
      subject: 'שאלה', content: 'יש במלאי?',
    });
    expect(res.status).toBe(200);
    const { message } = await res.json() as { message: { toSellerId: string; toStoreName: string } };
    expect(message.toSellerId).toBe(SELLER);
    expect(message.toStoreName).toBe('קרמיקה');
  });

  it('answers 404 for a store that does not exist instead of writing a message to nobody', async () => {
    const res = await post({ toStoreId: '22222222-2222-4222-8222-0000000000ff', subject: 'ש', content: 'ת' });
    expect(res.status).toBe(404);
    expect(await query('SELECT 1 FROM messages')).toMatchObject({ rowCount: 0 });
  });

  it('writes the message and its notification together', async () => {
    await post({ toStoreId: STORE, subject: 'שאלה', content: 'יש במלאי?' });
    const notifications = await query<{ user_id: string; type: string }>('SELECT user_id, type FROM notifications');
    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0]!.user_id).toBe(SELLER);
    expect(notifications.rows[0]!.type).toBe('new_message');
  });
});

describe('how big a message may be', () => {
  it('refuses an over-long subject or body — the form’s maxlength is not the rule', async () => {
    const tooLongSubject = await post({
      toStoreId: STORE, subject: 'א'.repeat(MAX_MESSAGE_SUBJECT_LEN + 1), content: 'ת',
    });
    expect(tooLongSubject.status).toBe(400);
    const tooLongBody = await post({
      toStoreId: STORE, subject: 'ש', content: 'ב'.repeat(MAX_MESSAGE_CONTENT_LEN + 1),
    });
    expect(tooLongBody.status).toBe(400);
    expect(await query('SELECT 1 FROM messages')).toMatchObject({ rowCount: 0 });
  });

  it('refuses an over-long reply too — that box has no maxlength at all', async () => {
    const opened = await createMessage({
      fromUserId: BUYER, fromName: 'קונה', fromEmail: 'b@x.test',
      toStoreId: STORE, toSellerId: SELLER, toStoreName: 'קרמיקה',
      subject: 'שאלה', content: 'יש במלאי?',
    });
    const res = await post({ replyToId: opened.id, content: 'ב'.repeat(MAX_MESSAGE_CONTENT_LEN + 1) });
    expect(res.status).toBe(400);
  });

  it('accepts a message right at the limit', async () => {
    const res = await post({
      toStoreId: STORE, subject: 'א'.repeat(MAX_MESSAGE_SUBJECT_LEN), content: 'ב'.repeat(MAX_MESSAGE_CONTENT_LEN),
    });
    expect(res.status).toBe(200);
  });
});

describe('who may read a conversation', () => {
  it('gives a thread’s replies to its buyer and to its seller', async () => {
    const opened = await createMessage({
      fromUserId: BUYER, fromName: 'קונה', fromEmail: 'b@x.test',
      toStoreId: STORE, toSellerId: SELLER, toStoreName: 'קרמיקה',
      subject: 'שאלה', content: 'יש במלאי?',
    });
    await createMessage({
      fromUserId: SELLER, fromName: 'מוכר', fromEmail: 's@x.test',
      toStoreId: '', toSellerId: BUYER, toStoreName: 'קרמיקה',
      subject: 'Re', content: 'כן', replyToId: opened.id,
    });

    session = SELLER;
    expect(((await (await get(`?repliesFor=${opened.id}`)).json()) as { replies: unknown[] }).replies).toHaveLength(1);
    session = BUYER;
    expect(((await (await get(`?repliesFor=${opened.id}`)).json()) as { replies: unknown[] }).replies).toHaveLength(1);
  });

  it('gives a stranger nothing, however valid the thread id is', async () => {
    // A thread id is hard to guess, and hard to guess is not a permission — the same rule
    // `checkoutOwner` encodes. These are private conversations between two named people.
    const opened = await createMessage({
      fromUserId: BUYER, fromName: 'קונה', fromEmail: 'b@x.test',
      toStoreId: STORE, toSellerId: SELLER, toStoreName: 'קרמיקה',
      subject: 'שאלה', content: 'יש במלאי?',
    });
    await createMessage({
      fromUserId: SELLER, fromName: 'מוכר', fromEmail: 's@x.test',
      toStoreId: '', toSellerId: BUYER, toStoreName: 'קרמיקה',
      subject: 'Re', content: 'סוד מסחרי', replyToId: opened.id,
    });

    session = OTHER_SELLER;
    const body = await (await get(`?repliesFor=${opened.id}`)).json() as { replies: unknown[] };
    expect(body.replies).toEqual([]);
  });

  it('turns away an unauthenticated caller before it reads anything', async () => {
    session = null;
    expect((await get('?repliesFor=whatever')).status).toBe(401);
    expect((await post({ toStoreId: STORE, subject: 'ש', content: 'ת' })).status).toBe(401);
  });
});
