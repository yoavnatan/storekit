import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import {
  createNotification,
  deleteAllNotificationsForUser,
  deleteNotification,
  deleteNotificationsByRelatedIds,
  getNotificationsForUser,
  getNotificationsPage,
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

  /**
   * The poll cursor IS `createdAt`, so `createdAt` must survive a round trip through the browser
   * without losing precision — and until 2026-08-03 it did not.
   *
   * `created_at` is `timestamptz`: Postgres keeps microseconds, a JS `Date` holds milliseconds, and
   * the mapper used to rebuild the field with `new Date(…).toISOString()`. A row stored at
   * `…:09.503137Z` was handed to the client as `…:09.503Z`, and `created_at > '…503Z'` is still
   * true for `…503137` — so the newest notification was returned on every poll forever. Inside one
   * page the toast container's `shownKeys` hid it; a reload empties that set, so the seller got the
   * same "new message" toast on every single refresh. Found by a person using the dashboard.
   *
   * The test above cannot see this: it pins `created_at` to `…10:00:00.000Z`, which has no
   * microseconds to lose. **A fixture whose value is already round is a fixture that cannot catch
   * rounding.**
   */
  it('does not hand back a row as newer than its own cursor (microsecond truncation)', async () => {
    const n = await notify({ title: 'הודעה' });
    await query('UPDATE notifications SET created_at = $1 WHERE id = $2',
      ['2026-01-01T10:00:00.503137Z', n.id]);

    const cursor = (await getNotificationsForUser(USER))[0]!.createdAt;

    // Polling with the cursor this row produced must return NOTHING — it is not newer than itself.
    expect((await getNotificationsForUser(USER, cursor)).map((x) => x.id)).toEqual([]);
    // And the microseconds are the reason: they have to reach the client at all.
    expect(cursor).toContain('.503137');
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

/**
 * Paging older entries — `getNotificationsPage`, the bell's "הצג עוד".
 *
 * The bug it was built for: the dropdown drew the newest ten of the fifty the poll returns, and
 * with 48 notifications the other 38 were reachable by nothing at all (owner, סשן ג׳).
 *
 * The case worth having a test for is the one that made OFFSET the right answer rather than a
 * keyset cursor: `created_at` defaults to `now()`, which in Postgres is the TRANSACTION timestamp,
 * so rows written together share one byte-identical instant. A `created_at < cursor` page drops the
 * rest of a tie group silently — no error, no gap on screen, just entries that can never be
 * reached. So the pages are asserted to reconstruct the feed EXACTLY, ties included.
 */
describe('paging older entries', () => {
  async function seed(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await notify({ title: `n${i}`, body: String(i) });
    }
  }

  it('walks the whole feed in pages, with no gap and no repeat', async () => {
    await seed(25);
    const whole = await getNotificationsForUser(USER);
    expect(whole).toHaveLength(25);

    const paged: string[] = [];
    for (let offset = 0; offset < 25; offset += 10) {
      const { notifications } = await getNotificationsPage(USER, offset, 10);
      paged.push(...notifications.map((n) => n.id));
    }
    expect(paged).toEqual(whole.map((n) => n.id));
  });

  it('says whether there is more, and stops saying it at the end', async () => {
    await seed(25);
    expect((await getNotificationsPage(USER, 0, 10)).hasMore).toBe(true);
    expect((await getNotificationsPage(USER, 10, 10)).hasMore).toBe(true);
    // Exactly the last five: the page is full only in the sense that there is nothing behind it.
    const last = await getNotificationsPage(USER, 20, 10);
    expect(last.notifications).toHaveLength(5);
    expect(last.hasMore).toBe(false);
    // And a page that lands exactly on the boundary is not "more" either.
    await query('DELETE FROM notifications');
    await seed(20);
    expect((await getNotificationsPage(USER, 10, 10)).hasMore).toBe(false);
  });

  /**
   * The page size stops one below `FEED_LIMIT` so the extra probe row always fits.
   *
   * Asking for the biggest page allowed used to answer `hasMore: false` with entries still behind
   * it: the route asked the query for `limit + 1` and the query clamped that back down to the cap,
   * so the probe row was the one thrown away while the comparison it fed was not. The bell's button
   * would have vanished mid-feed. Both numbers live in `getNotificationsPage` now, which is what
   * makes this case expressible at all.
   */
  it('still reports more when asked for the largest page it allows', async () => {
    await seed(60);
    const big = await getNotificationsPage(USER, 0, 500);
    expect(big.notifications.length).toBeLessThanOrEqual(49);
    expect(big.hasMore, 'a full page with 60 rows behind it is not the end of the feed').toBe(true);
  });

  it('keeps every row of a tie group — rows written in ONE transaction share a timestamp', async () => {
    // `now()` is the transaction clock, so this is not a contrived collision: it is what any
    // multi-notification write inside one transaction produces.
    await query('BEGIN');
    for (let i = 0; i < 6; i += 1) await notify({ title: `tie${i}` });
    await query('COMMIT');

    const whole = await getNotificationsForUser(USER);
    const stamps = new Set(whole.map((n) => n.createdAt));
    expect(stamps.size, 'the premise of this test: one transaction, one timestamp').toBe(1);

    const first = await getNotificationsPage(USER, 0, 3);
    const second = await getNotificationsPage(USER, 3, 3);
    const ids = [...first.notifications, ...second.notifications].map((n) => n.id);
    expect(new Set(ids).size, 'a page repeated or dropped a row').toBe(6);
    expect([...ids].sort()).toEqual(whole.map((n) => n.id).sort());
  });

  it('never returns another account\'s notifications', async () => {
    await seed(3);
    await notify({ userId: OTHER, title: 'not yours' });
    const { notifications: page } = await getNotificationsPage(USER, 0, 50);
    expect(page).toHaveLength(3);
    expect(page.every((n) => n.userId === USER)).toBe(true);
  });

  it('clamps nonsense instead of raising or handing back the table', async () => {
    await seed(4);
    expect((await getNotificationsPage(USER, -5, 10)).notifications).toHaveLength(4);
    expect((await getNotificationsPage(USER, Number.NaN, 10)).notifications).toHaveLength(4);
    // Above the cap the limit is capped, not honoured — one request may not become an export.
    expect((await getNotificationsPage(USER, 0, 5_000)).notifications.length).toBeLessThanOrEqual(49);
    // A limit of zero would make the bell's button do nothing forever; it floors at one.
    expect((await getNotificationsPage(USER, 0, 0)).notifications).toHaveLength(1);
  });

  it('runs past the poll\'s own 50-row ceiling', async () => {
    await seed(55);
    expect(await getNotificationsForUser(USER)).toHaveLength(50);
    const beyond = await getNotificationsPage(USER, 50, 10);
    expect(beyond.notifications, 'the entries the old dropdown could never reach').toHaveLength(5);
    expect(beyond.hasMore).toBe(false);
  });
});
