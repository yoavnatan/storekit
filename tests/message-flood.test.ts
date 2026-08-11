import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/lib/db.js';
import {
  MAX_UNANSWERED_IN_THREAD,
  newThreadRules,
  replyRules,
  unansweredRun,
} from '../src/lib/message-flood.js';
import {
  MAX_RATE_WINDOW_SEC,
  adminLoginRules,
  checkAuthRate,
  countAuthAttempt,
  couponLookupRules,
  purgeExpiredAuthAttempts,
  registerRules,
  sellerLoginRules,
} from '../src/lib/rate-limit.js';

/**
 * Message flood control (`lib/message-flood.ts`), and the one thing outside it that can silently
 * switch it off.
 *
 * The route-level cases run against a real Postgres and the real modules under `/api/messages`,
 * for the same reason `messages-api.test.ts` does: what is being asserted is a decision the route
 * makes, and a mocked `messages.js` would assert the mock.
 */

const SELLER = '11111111-1111-4111-8111-000000000001';
const STORE = '22222222-2222-4222-8222-000000000001';
const BUYER = 'buyer-account-1';

let session: string | null = BUYER;

vi.mock('../src/lib/seller-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/seller-auth.js')>()),
  getSellerSession: () => session,
  getSellerById: async (id: string) => ({ id, name: 'שולח', email: `${id}@x.test` }),
}));

const { POST } = await import('../src/pages/api/messages.js');
const { POST: adminPost } = await import('../src/pages/api/admin-messages.js');
const { createAdminThread } = await import('../src/lib/admin-messages.js');

const cookies = { get: () => undefined } as never;

function post(body: unknown) {
  return POST({
    request: new Request('https://x.test/api/messages', { method: 'POST', body: JSON.stringify(body) }),
    cookies,
  } as never) as Promise<Response>;
}
function postSystem(body: unknown) {
  return adminPost({
    request: new Request('https://x.test/api/admin-messages', { method: 'POST', body: JSON.stringify(body) }),
    cookies,
  } as never) as Promise<Response>;
}

beforeEach(async () => {
  await query('DELETE FROM messages');
  await query('DELETE FROM admin_messages');
  await query('DELETE FROM notifications');
  await query('DELETE FROM auth_attempts');
  session = BUYER;
});

describe('the run rule — how many messages one side may send unanswered', () => {
  it('counts only the messages at the END of the thread, and any answer resets it', () => {
    const thread = [{ fromUserId: 'a' }, { fromUserId: 'a' }, { fromUserId: 'b' }, { fromUserId: 'a' }];
    expect(unansweredRun(thread, 'a')).toBe(1);
    expect(unansweredRun(thread, 'b')).toBe(0);
    expect(unansweredRun([], 'a')).toBe(0);
    expect(unansweredRun([{ fromUserId: 'a' }, { fromUserId: 'a' }], 'a')).toBe(2);
  });

  it('refuses the message that would extend the run past the cap, and lets it through once the other side answers', async () => {
    const opened = await post({ toStoreId: STORE, subject: 'שאלה', content: 'יש במלאי?' });
    expect(opened.status).toBe(200);
    const { message } = await opened.json() as { message: { id: string } };

    // The root counts as the first of its author's run, so the cap is reached after
    // MAX_UNANSWERED_IN_THREAD - 1 further replies from the same side.
    for (let i = 1; i < MAX_UNANSWERED_IN_THREAD; i++) {
      expect((await post({ replyToId: message.id, content: `עוד ${i}` })).status).toBe(200);
    }
    const refused = await post({ replyToId: message.id, content: 'ועוד אחת' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('ברצף') });

    // The SELLER is on the other side of this thread and is unaffected by the buyer's run.
    session = SELLER;
    expect((await post({ replyToId: message.id, content: 'בטח, יש' })).status).toBe(200);

    // And the answer clears the buyer's run rather than merely pausing it.
    session = BUYER;
    expect((await post({ replyToId: message.id, content: 'מעולה, תודה' })).status).toBe(200);
  });

  it('applies to the SELLER exactly as it does to the buyer', async () => {
    const opened = await post({ toStoreId: STORE, subject: 'שאלה', content: 'יש במלאי?' });
    const { message } = await opened.json() as { message: { id: string } };

    session = SELLER;
    for (let i = 0; i < MAX_UNANSWERED_IN_THREAD; i++) {
      expect((await post({ replyToId: message.id, content: `דחיפה ${i}` })).status).toBe(200);
    }
    expect((await post({ replyToId: message.id, content: 'עוד דחיפה' })).status).toBe(429);
  });
});

describe('the seller↔admin system thread is inside the same ceiling', () => {
  it('caps a seller pushing at the admin thread, or the limited path simply gets routed around', async () => {
    // The messages there carry `fromRole`, not an account id, so the run is measured over roles.
    // Without this the platform would have one throttled write path and one open one, side by side
    // in the same tab — which is not a limit, it is a detour sign.
    const root = await createAdminThread(SELLER, 'הודעת מערכת', 'שלום');
    session = SELLER;
    for (let i = 0; i < MAX_UNANSWERED_IN_THREAD; i++) {
      expect((await postSystem({ threadId: root.id, content: `תשובה ${i}` })).status).toBe(200);
    }
    expect((await postSystem({ threadId: root.id, content: 'עוד אחת' })).status).toBe(429);
  });
});

describe('the rate rule — opening threads', () => {
  it('refuses a fourth new conversation against the same store within the window', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await post({ toStoreId: STORE, subject: `נושא ${i}`, content: 'שאלה' })).status).toBe(200);
    }
    const refused = await post({ toStoreId: STORE, subject: 'נושא 4', content: 'שאלה' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();
    // Three threads were written, and the refused one was not.
    expect(await query('SELECT 1 FROM messages WHERE reply_to_id IS NULL')).toMatchObject({ rowCount: 3 });
  });

  it('does not spend the sender’s allowance on a message that was never written', async () => {
    // A store that does not exist is refused BEFORE the gate counts anything — otherwise a typo, or
    // a client retrying against a stale id, would burn the ceiling for a store the sender never
    // reached. Three real threads must still be available afterwards.
    for (let i = 0; i < 4; i++) {
      expect((await post({ toStoreId: '22222222-2222-4222-8222-0000000000ff', subject: 'ש', content: 'ת' })).status).toBe(404);
    }
    for (let i = 0; i < 3; i++) {
      expect((await post({ toStoreId: STORE, subject: `נושא ${i}`, content: 'שאלה' })).status).toBe(200);
    }
  });
});

describe('the purge job may not outlive a rule’s window', () => {
  it('every rule builder on the platform stays inside MAX_RATE_WINDOW_SEC', () => {
    const everyRule = [
      ...sellerLoginRules('a@b.test', '1.2.3.4'),
      ...registerRules('1.2.3.4'),
      ...adminLoginRules('1.2.3.4'),
      ...couponLookupRules('shop', '1.2.3.4'),
      ...newThreadRules(BUYER, STORE),
      ...replyRules(BUYER),
    ];
    expect(everyRule.length).toBeGreaterThan(0);
    for (const rule of everyRule) expect(rule.windowSec).toBeLessThanOrEqual(MAX_RATE_WINDOW_SEC);
  });

  it('leaves a message bucket alone while its window is still running', async () => {
    // The bug this pins: the purge deleted anything older than the 15-minute AUTH window, so an
    // hour-long message bucket was wiped at minute 16 and the limit stopped limiting — with nothing
    // failing anywhere. Backdate a full bucket by 20 minutes, purge, and it must still refuse.
    const rules = newThreadRules(BUYER, STORE);
    for (let i = 0; i < 3; i++) await countAuthAttempt(rules);
    await query("UPDATE auth_attempts SET window_start = now() - interval '20 minutes'");

    await purgeExpiredAuthAttempts();

    expect(await checkAuthRate(rules)).toMatchObject({ allowed: false });
  });

  it('still drops a bucket whose window has genuinely lapsed', async () => {
    await countAuthAttempt(newThreadRules(BUYER, STORE));
    await query("UPDATE auth_attempts SET window_start = now() - interval '3 hours'");
    expect(await purgeExpiredAuthAttempts()).toBeGreaterThan(0);
    expect(await query('SELECT 1 FROM auth_attempts')).toMatchObject({ rowCount: 0 });
  });
});
