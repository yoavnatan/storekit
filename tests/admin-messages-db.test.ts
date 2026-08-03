import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/db.js';
import {
  createAdminThread,
  deleteAdminThread,
  getAdminThreadById,
  getAdminThreadsForSeller,
  getAdminThreadsPage,
  getUnreadAdminThreadIdsForSeller,
  markAdminThreadReadByAdmin,
  markAdminThreadReadBySeller,
  replyToAdminThread,
  DEFAULT_ADMIN_SUBJECT,
} from '../src/lib/admin-messages.js';
import { filterAndSortAdminThreads } from '../src/lib/admin-threads-query.js';

/** `getAllAdminThreads()` is gone (§3) — the paged reader replaced it. These assertions are about
 *  the whole (tiny) set, so they ask for one page big enough to hold it. */
const allThreads = () => getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false }, 1, 1000);

/**
 * Admin ↔ seller "system" threads, against a real Postgres — moved with `messages` and
 * `notifications` (DB_MIGRATION_PLAN.md §8).
 *
 * **`admin-messages.test.ts` covers `groupAdminThreads` and nothing else** — the pure grouping, over
 * arrays built by hand. Not one test opened, answered, read or deleted a thread, so a replacement
 * that lost every reply, showed one seller another's inbox, or let a seller mark someone else's
 * notice read would have left it green.
 *
 * This module carries the platform's own record of a block and the seller's appeal to it, which is
 * why the ownership guards below get a test each rather than a shared one.
 */

const SELLER = '11111111-1111-4111-8111-000000000001';
const OTHER_SELLER = '11111111-1111-4111-8111-000000000002';

beforeEach(async () => {
  await query('DELETE FROM admin_messages');
});

describe('opening a thread', () => {
  it('is the admin’s message, already read by them and unread by the seller', async () => {
    const opened = await createAdminThread(SELLER, 'החנות נחסמה', 'פנה אלינו');
    expect(opened.fromRole).toBe('admin');
    expect(opened.readByAdmin).toBe(true);
    expect(opened.readBySeller).toBe(false);
    expect(opened.subject).toBe('החנות נחסמה');
    expect('replyToId' in opened).toBe(false);
  });

  it('falls back to the default subject rather than storing a blank one', async () => {
    const opened = await createAdminThread(SELLER, '   ', 'תוכן');
    expect(opened.subject).toBe(DEFAULT_ADMIN_SUBJECT);
    expect((await getAdminThreadById(opened.id))!.subject).toBe(DEFAULT_ADMIN_SUBJECT);
  });

  it('gives every subject its own thread — not one pile per seller', async () => {
    await createAdminThread(SELLER, 'חסימה', 'א');
    await createAdminThread(SELLER, 'שינוי מדיניות', 'ב');
    const threads = await getAdminThreadsForSeller(SELLER);
    expect(threads.map((t) => t.subject).sort()).toEqual(['חסימה', 'שינוי מדיניות']);
  });
});

describe('replying', () => {
  it('attaches the reply to its root and takes the seller from it, not from the caller', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    const answer = (await replyToAdminThread(opened.id, 'seller', 'למה?'))!;
    expect(answer.replyToId).toBe(opened.id);
    expect(answer.sellerId).toBe(SELLER);
    expect(answer.readBySeller).toBe(true);   // the sender has seen their own message
    expect(answer.readByAdmin).toBe(false);
    const thread = (await getAdminThreadById(opened.id))!;
    expect(thread.messages.map((m) => m.id)).toEqual([opened.id, answer.id]);
    expect(thread.lastMessage.id).toBe(answer.id);
  });

  it('answers null for a thread that does not exist, without writing anything', async () => {
    // Written as one INSERT … SELECT rather than read-then-write: a thread deleted between the
    // check and the insert would otherwise leave a reply hanging off nothing.
    expect(await replyToAdminThread('99999999-9999-4999-8999-0000000000ff', 'admin', 'x')).toBeNull();
    expect((await allThreads()).threads).toEqual([]);
  });

  it('answers null for a malformed thread id rather than raising', async () => {
    expect(await replyToAdminThread('thread-1', 'admin', 'x')).toBeNull();
    expect(await getAdminThreadById('thread-1')).toBeNull();
    expect(await deleteAdminThread('thread-1')).toBe(false);
  });

  it('keeps the admin’s own reply unread for the seller', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await markAdminThreadReadBySeller(opened.id, SELLER);
    const answer = (await replyToAdminThread(opened.id, 'admin', 'עוד'))!;
    expect(answer.readBySeller).toBe(false);
    expect((await getAdminThreadById(opened.id))!.unreadForSeller).toBe(1);
  });
});

describe('whose inbox is whose', () => {
  it('shows a seller only their own threads', async () => {
    await createAdminThread(SELLER, 'שלי', 'א');
    await createAdminThread(OTHER_SELLER, 'של אחר', 'ב');
    expect((await getAdminThreadsForSeller(SELLER)).map((t) => t.subject)).toEqual(['שלי']);
    expect((await allThreads()).threads).toHaveLength(2);
  });

  it('orders threads by most recent activity, and a reply moves its thread up', async () => {
    const older = await createAdminThread(SELLER, 'ישן', 'א');
    const newer = await createAdminThread(SELLER, 'חדש', 'ב');
    await query('UPDATE admin_messages SET created_at = $1 WHERE id = $2', ['2026-01-01T10:00:00.000Z', older.id]);
    expect((await getAdminThreadsForSeller(SELLER)).map((t) => t.id)).toEqual([newer.id, older.id]);
    await replyToAdminThread(older.id, 'seller', 'עדיין רלוונטי');
    expect((await getAdminThreadsForSeller(SELLER))[0]!.id).toBe(older.id);
  });

  it('finds a thread by its root id whether the root or a reply matches', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await replyToAdminThread(opened.id, 'seller', 'ערעור');
    // The root gone, the reply left: the thread still resolves by the dead root's id, which is what
    // keeps an appeal from vanishing from the seller's inbox.
    await query('DELETE FROM admin_messages WHERE id = $1', [opened.id]);
    const thread = (await getAdminThreadById(opened.id))!;
    expect(thread.messages).toHaveLength(1);
    expect(thread.subject).toBe(DEFAULT_ADMIN_SUBJECT);
  });
});

describe('read state', () => {
  it('marks a whole thread read for the seller it belongs to', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await replyToAdminThread(opened.id, 'admin', 'עוד');
    await markAdminThreadReadBySeller(opened.id, SELLER);
    expect((await getAdminThreadById(opened.id))!.unreadForSeller).toBe(0);
  });

  it('refuses a thread id forged from another seller’s inbox', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await markAdminThreadReadBySeller(opened.id, OTHER_SELLER);
    expect((await getAdminThreadById(opened.id))!.unreadForSeller).toBe(1);
  });

  it('marks read for the admin without touching the seller’s side', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await replyToAdminThread(opened.id, 'seller', 'ערעור');
    await markAdminThreadReadByAdmin(opened.id);
    const thread = (await getAdminThreadById(opened.id))!;
    expect(thread.unreadForAdmin).toBe(0);
    expect(thread.unreadForSeller).toBe(1);
  });

  it('does not count the seller’s own reply as unread for them', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await markAdminThreadReadBySeller(opened.id, SELLER);
    await replyToAdminThread(opened.id, 'seller', 'ערעור');
    expect(await getUnreadAdminThreadIdsForSeller(SELLER)).toEqual([]);
    expect((await getAdminThreadById(opened.id))!.unreadForAdmin).toBe(1);
  });

  it('lists each unread thread ONCE, however many unread messages it holds', async () => {
    // The row highlight is per thread; the file version mapped over messages, so a thread with
    // three unread notices appeared three times in a list the client treats as a set.
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await replyToAdminThread(opened.id, 'admin', 'ב');
    await replyToAdminThread(opened.id, 'admin', 'ג');
    expect(await getUnreadAdminThreadIdsForSeller(SELLER)).toEqual([opened.id]);
  });

  it('reports the thread id, not the reply id, when only a reply is unread', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await markAdminThreadReadBySeller(opened.id, SELLER);
    await replyToAdminThread(opened.id, 'admin', 'עוד');
    expect(await getUnreadAdminThreadIdsForSeller(SELLER)).toEqual([opened.id]);
  });
});

describe('deleting a thread', () => {
  it('removes the root and every reply — there is no cascade on reply_to_id', async () => {
    const opened = await createAdminThread(SELLER, 'חסימה', 'א');
    await replyToAdminThread(opened.id, 'seller', 'ערעור');
    expect(await deleteAdminThread(opened.id)).toBe(true);
    expect(await getAdminThreadById(opened.id)).toBeNull();
    expect((await allThreads()).threads).toEqual([]);
  });

  it('reports false for a thread already gone, and leaves the others standing', async () => {
    const doomed = await createAdminThread(SELLER, 'למחיקה', 'א');
    await createAdminThread(SELLER, 'נשארת', 'ב');
    expect(await deleteAdminThread(doomed.id)).toBe(true);
    expect(await deleteAdminThread(doomed.id)).toBe(false);
    expect((await getAdminThreadsForSeller(SELLER)).map((t) => t.subject)).toEqual(['נשארת']);
  });
});

describe('getAdminThreadsPage agrees with filterAndSortAdminThreads', () => {
  // The paged reader (§3) narrows, sorts and slices at THREAD level in SQL, where the toolbar's
  // rules used to run over every system message on the platform. `filterAndSortAdminThreads` is
  // the pure twin those rules are defined in — so both routes run over the same threads here and
  // have to produce the same list, for every sort the toolbar offers.
  beforeEach(async () => {
    await query('DELETE FROM admin_messages');
    // The UNREAD thread is deliberately the OLDEST one. If it were also the most recent, the two
    // sorts the toolbar offers would return the same list and the unread-first case would be
    // asserting nothing — which is exactly what sabotaging the sort proved before this fixture.
    const stale = await createAdminThread(SELLER, 'ישן ולא נענה', 'א');
    // A seller reply is what makes a thread unread FOR THE ADMIN — the only kind that counts.
    await replyToAdminThread(stale.id, 'seller', 'ערעור');
    await query('UPDATE admin_messages SET created_at = $1 WHERE id = $2 OR reply_to_id = $2',
      ['2026-01-01T10:00:00.000Z', stale.id]);
    await createAdminThread(SELLER, 'חדש', 'ב');
    await createAdminThread(OTHER_SELLER, 'חדש יותר', 'ג');
  });

  for (const sortCol of ['recent', 'unread'] as const) {
    for (const unreadOnly of [false, true]) {
      it(`sort=${sortCol} unreadOnly=${unreadOnly}`, async () => {
        const q = { sortCol, unreadOnly };
        const page = await getAdminThreadsPage(q, 1, 1000);
        const pure = filterAndSortAdminThreads((await allThreads()).threads, q);
        expect(page.threads.map((t) => t.id)).toEqual(pure.map((t) => t.id));
        expect(page.total).toBe(pure.length);
      });
    }
  }

  it('counts unread over EVERY thread, not the filtered ones', async () => {
    // The tab badge must not move because a filter is open — the same rule the other tabs follow.
    const open = await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false }, 1, 1000);
    const filtered = await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: true }, 1, 1000);
    expect(filtered.unreadForAdmin).toBe(open.unreadForAdmin);
    expect(filtered.unreadForAdmin).toBeGreaterThan(0);
    // …while `total` IS the filtered count, which is what the pager needs.
    expect(filtered.total).toBeLessThan(open.total);
    expect(filtered.totalUnfiltered).toBe(open.total);
  });

  it('pages without dropping or repeating a thread', async () => {
    const all = (await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false }, 1, 1000)).threads.map((t) => t.id);
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      seen.push(...(await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false }, page, 1)).threads.map((t) => t.id));
    }
    expect(seen).toEqual(all);
  });
});
