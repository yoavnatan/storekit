import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import {
  createNotification,
  deleteAllNotificationsForUser,
  deleteNotification,
  deleteNotificationsByRelatedIds,
  getNotificationsForUser,
  getUnreadCountForUser,
  getUnreadSellerReplyCount,
  markAllReadForUser,
  markNotificationRead,
} from '../src/lib/notifications.js';

/**
 * The in-app notification feed, against a real Postgres — moved with `messages` and
 * `admin-messages` (DB_MIGRATION_PLAN.md §8).
 *
 * **Every test in the repo that touched notifications MOCKED the whole module.** Four files stub it
 * (`checkout`, `product-stock-cas`, `store-products-import`, `csv-pooled-stock-roundtrip`) and the
 * assertions in `checkout.test.ts` are about the mock's call arguments, which is a test of checkout
 * and not of this. A replacement that returned an empty feed for everyone, mixed up whose
 * notifications were whose, or let one account delete another's would have passed all of them.
 *
 * The two things worth watching most closely here are the ones a reader cannot see: the badge count
 * is a `COUNT`, which arrives as a bigint and therefore as a STRING under `pg`, and the poll cursor
 * arrives from the browser's `localStorage` and can be anything at all.
 */

const USER = '11111111-1111-4111-8111-000000000001';
const OTHER = '11111111-1111-4111-8111-000000000002';

function notify(over: Partial<Parameters<typeof createNotification>[0]> = {}) {
  return createNotification({
    userId: USER,
    role: 'seller',
    type: 'new_message',
    title: 'הודעה חדשה',
    body: '',
    ...over,
  });
}

beforeEach(async () => {
  await query('DELETE FROM notifications');
});

describe('writing one', () => {
  it('writes every field back, and omits the optionals it was not given', async () => {
    const written = await notify({
      type: 'new_order', title: 'הזמנה חדשה!', body: 'על סך ₪120',
      relatedId: 'order-7', storeSlug: 'keramika', storeName: 'קרמיקה',
    });
    const [read] = await getNotificationsForUser(USER);
    expect(read!.id).toBe(written.id);
    expect(read!.type).toBe('new_order');
    expect(read!.body).toBe('על סך ₪120');
    expect(read!.relatedId).toBe('order-7');
    expect(read!.storeSlug).toBe('keramika');
    expect(read!.read).toBe(false);
  });

  it('leaves absent optionals absent rather than turning them into empty strings', async () => {
    await notify();
    const [read] = await getNotificationsForUser(USER);
    expect('relatedId' in read!).toBe(false);
    expect('storeSlug' in read!).toBe(false);
    expect('storeName' in read!).toBe(false);
  });

  it('keeps a related id that is not a uuid — the column is text on purpose', async () => {
    // `related_id` holds order ids, product ids and thread ids alike, and imported rows carry
    // pre-uuid values. Casting it would have made a whole class of notification unwritable.
    await notify({ relatedId: 'order-1' });
    expect((await getNotificationsForUser(USER))[0]!.relatedId).toBe('order-1');
  });
});

describe('reading the feed', () => {
  it('gives one person their own notifications and nobody else’s', async () => {
    await notify();
    await notify({ userId: OTHER });
    expect(await getNotificationsForUser(USER)).toHaveLength(1);
  });

  it('is newest first, with a stable tie-break on a shared timestamp', async () => {
    const a = await notify({ title: 'א' });
    const b = await notify({ title: 'ב' });
    await query('UPDATE notifications SET created_at = $1', ['2026-03-01T10:00:00.000Z']);
    const once = (await getNotificationsForUser(USER)).map((n) => n.id);
    expect(once).toEqual((await getNotificationsForUser(USER)).map((n) => n.id));
    expect(new Set(once)).toEqual(new Set([a.id, b.id]));
  });

  it('caps the feed at 50 in SQL, not after reading everything', async () => {
    // The header polls this every 15 seconds for every open tab; the old shape read the whole file
    // to throw away all but the newest 50.
    for (let i = 0; i < 55; i++) await notify({ title: `n${i}` });
    expect(await getNotificationsForUser(USER)).toHaveLength(50);
  });

  it('returns only what is newer than the cursor', async () => {
    const old = await notify({ title: 'ישן' });
    await query('UPDATE notifications SET created_at = $1 WHERE id = $2', ['2026-01-01T10:00:00.000Z', old.id]);
    const fresh = await notify({ title: 'חדש' });
    const since = (await getNotificationsForUser(USER)).find((n) => n.id === old.id)!.createdAt;
    expect((await getNotificationsForUser(USER, since)).map((n) => n.id)).toEqual([fresh.id]);
  });

  it('IGNORES a cursor it cannot parse instead of raising or going silent', async () => {
    // The cursor lives in the browser's localStorage, so it can be anything. Postgres raises on a
    // timestamp literal it cannot parse, which would be a 500 on a poll that runs on every page;
    // and answering "nothing is newer" would be PERMANENT, because the client only ever rewrites
    // the cursor from a row this endpoint returned.
    await notify();
    expect(await getNotificationsForUser(USER, 'not-a-date')).toHaveLength(1);
    expect(await getNotificationsForUser(USER, '')).toHaveLength(1);
  });
});

describe('the badge', () => {
  it('counts this person’s unread notifications as a NUMBER', async () => {
    // `COUNT` is bigint — a string from `pg`, a number from PGlite. Left alone, `count + 1` would
    // concatenate in production and add in the tests.
    await notify();
    await notify();
    await notify({ userId: OTHER });
    const count = await getUnreadCountForUser(USER);
    expect(count).toBe(2);
    expect(typeof count).toBe('number');
  });

  it('drops to zero once everything is read', async () => {
    await notify();
    await notify();
    await markAllReadForUser(USER);
    expect(await getUnreadCountForUser(USER)).toBe(0);
  });

  it('counts only seller replies for the buyer dashboard’s messages tab', async () => {
    await notify({ type: 'seller_reply' });
    await notify({ type: 'new_order' });
    expect(await getUnreadSellerReplyCount(USER)).toBe(1);
  });

  it('marks all read for one person only', async () => {
    await notify();
    await notify({ userId: OTHER });
    await markAllReadForUser(USER);
    expect(await getUnreadCountForUser(OTHER)).toBe(1);
  });
});

describe('an id is not a permission', () => {
  it('refuses to mark another person’s notification read', async () => {
    const mine = await notify();
    expect(await markNotificationRead(mine.id, OTHER)).toBe(false);
    expect((await getNotificationsForUser(USER))[0]!.read).toBe(false);
    expect(await markNotificationRead(mine.id, USER)).toBe(true);
  });

  it('refuses to delete another person’s notification', async () => {
    const mine = await notify();
    expect(await deleteNotification(mine.id, OTHER)).toBe(false);
    expect(await getNotificationsForUser(USER)).toHaveLength(1);
    expect(await deleteNotification(mine.id, USER)).toBe(true);
    expect(await getNotificationsForUser(USER)).toHaveLength(0);
  });

  it('answers false for a malformed id rather than raising', async () => {
    expect(await markNotificationRead('notif-1', USER)).toBe(false);
    expect(await deleteNotification('notif-1', USER)).toBe(false);
  });

  it('clears by related id only within the asking account', async () => {
    await notify({ relatedId: 'order-7' });
    await notify({ userId: OTHER, relatedId: 'order-7' });
    await deleteNotificationsByRelatedIds(['order-7'], USER);
    expect(await getNotificationsForUser(USER)).toHaveLength(0);
    expect(await getNotificationsForUser(OTHER)).toHaveLength(1);
  });

  it('clears several related ids in one call, and leaves the rest', async () => {
    await notify({ relatedId: 'a' });
    await notify({ relatedId: 'b' });
    await notify({ relatedId: 'c' });
    await deleteNotificationsByRelatedIds(['a', 'b'], USER);
    expect((await getNotificationsForUser(USER)).map((n) => n.relatedId)).toEqual(['c']);
  });

  it('deletes everything for one account and nothing for any other', async () => {
    await notify();
    await notify();
    await notify({ userId: OTHER });
    await deleteAllNotificationsForUser(USER);
    expect(await getNotificationsForUser(USER)).toHaveLength(0);
    expect(await getNotificationsForUser(OTHER)).toHaveLength(1);
  });
});
