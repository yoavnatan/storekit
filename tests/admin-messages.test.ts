import { describe, expect, it } from 'vitest';
import { groupAdminThreads, DEFAULT_ADMIN_SUBJECT, type AdminMessage, type AdminThread } from '../src/lib/admin-messages.js';
import { filterAndSortAdminThreads } from '../src/lib/admin-threads-query.js';

let seq = 0;
function msg(overrides: Partial<AdminMessage>): AdminMessage {
  return {
    id: `m${++seq}`,
    sellerId: 's1',
    fromRole: 'admin',
    content: 'hi',
    readByAdmin: true,
    readBySeller: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('groupAdminThreads', () => {
  it('gives every admin-opened subject its own thread, not one per seller', () => {
    const threads = groupAdminThreads([
      msg({ id: 'a', sellerId: 's1', subject: 'חסימת חנות', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'b', sellerId: 's1', subject: 'עדכון מדיניות', createdAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(threads.map((t) => t.subject)).toEqual(['עדכון מדיניות', 'חסימת חנות']);
  });

  it('attaches replies to their root and picks the newest as lastMessage', () => {
    const threads = groupAdminThreads([
      msg({ id: 'a', subject: 'נושא', content: 'root', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'r1', replyToId: 'a', fromRole: 'seller', content: 'reply', createdAt: '2026-01-03T00:00:00.000Z' }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.messages.map((m) => m.content)).toEqual(['root', 'reply']);
    expect(threads[0]!.lastMessage.content).toBe('reply');
  });

  it('orders threads by most recently active first', () => {
    const threads = groupAdminThreads([
      msg({ id: 'a', subject: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'b', subject: 'b', createdAt: '2026-01-03T00:00:00.000Z' }),
      msg({ id: 'c', subject: 'c', createdAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(threads.map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('counts unread per side, ignoring each side’s own messages', () => {
    const threads = groupAdminThreads([
      msg({ id: 'a', subject: 'נושא', fromRole: 'admin', readBySeller: false }),
      msg({ id: 'r1', replyToId: 'a', fromRole: 'seller', readByAdmin: false }),
      msg({ id: 'r2', replyToId: 'a', fromRole: 'seller', readByAdmin: true }),
      msg({ id: 'r3', replyToId: 'a', fromRole: 'admin', readByAdmin: false }), // admin's own — never counts for admin
    ]);
    expect(threads[0]!.unreadForAdmin).toBe(1);
    expect(threads[0]!.unreadForSeller).toBe(1);
  });

  it('still renders a pre-thread row (no subject) as a thread of its own', () => {
    const threads = groupAdminThreads([msg({ id: 'legacy', content: 'ישן' })]);
    expect(threads[0]!.subject).toBe(DEFAULT_ADMIN_SUBJECT);
  });

  it('keeps a reply whose root is gone instead of dropping it', () => {
    const threads = groupAdminThreads([msg({ id: 'r1', replyToId: 'deleted', content: 'orphan' })]);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.lastMessage.content).toBe('orphan');
  });
});

function thread(overrides: Partial<AdminThread>): AdminThread {
  const root = msg({});
  return {
    id: root.id,
    sellerId: 's1',
    subject: 'נושא',
    root,
    messages: [root],
    lastMessage: root,
    unreadForAdmin: 0,
    unreadForSeller: 0,
    partyRole: 'seller',
    status: 'open',
    ...overrides,
  };
}

describe('filterAndSortAdminThreads', () => {
  it('leaves recency order untouched by default (sortCol: recent)', () => {
    const threads = [
      thread({ id: 't1', lastMessage: msg({ createdAt: '2026-01-02T00:00:00.000Z' }) }),
      thread({ id: 't2', lastMessage: msg({ createdAt: '2026-01-01T00:00:00.000Z' }) }),
    ];
    const result = filterAndSortAdminThreads(threads, { sortCol: 'recent', unreadOnly: false, role: 'all', status: 'all' });
    expect(result.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('sorts unread threads before read ones when sortCol is unread', () => {
    const threads = [
      thread({ id: 't1', unreadForAdmin: 0, lastMessage: msg({ createdAt: '2026-01-03T00:00:00.000Z' }) }),
      thread({ id: 't2', unreadForAdmin: 2, lastMessage: msg({ createdAt: '2026-01-01T00:00:00.000Z' }) }),
      thread({ id: 't3', unreadForAdmin: 0, lastMessage: msg({ createdAt: '2026-01-02T00:00:00.000Z' }) }),
    ];
    const result = filterAndSortAdminThreads(threads, { sortCol: 'unread', unreadOnly: false, role: 'all', status: 'all' });
    expect(result.map((t) => t.id)).toEqual(['t2', 't1', 't3']);
  });

  it('filters to only unread threads when unreadOnly is set', () => {
    const threads = [
      thread({ id: 't1', unreadForAdmin: 0 }),
      thread({ id: 't2', unreadForAdmin: 1 }),
    ];
    const result = filterAndSortAdminThreads(threads, { sortCol: 'recent', unreadOnly: true, role: 'all', status: 'all' });
    expect(result.map((t) => t.id)).toEqual(['t2']);
  });
});
