import { describe, expect, it } from 'vitest';
import { summarizeAdminThreads, type AdminMessage } from '../src/lib/admin-messages.js';

function msg(overrides: Partial<AdminMessage>): AdminMessage {
  return {
    id: Math.random().toString(36),
    sellerId: 's1',
    fromRole: 'admin',
    content: 'hi',
    readByAdmin: true,
    readBySeller: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('summarizeAdminThreads', () => {
  it('groups messages by seller and picks the most recent as lastMessage', () => {
    const summaries = summarizeAdminThreads([
      msg({ sellerId: 's1', content: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ sellerId: 's1', content: 'new', createdAt: '2026-01-02T00:00:00.000Z' }),
      msg({ sellerId: 's2', content: 'only', createdAt: '2026-01-01T12:00:00.000Z' }),
    ]);
    const s1 = summaries.find((s) => s.sellerId === 's1')!;
    expect(s1.lastMessage.content).toBe('new');
  });

  it('orders threads by most recently active first', () => {
    const summaries = summarizeAdminThreads([
      msg({ sellerId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ sellerId: 's2', createdAt: '2026-01-03T00:00:00.000Z' }),
      msg({ sellerId: 's3', createdAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(summaries.map((s) => s.sellerId)).toEqual(['s2', 's3', 's1']);
  });

  it('counts unread-for-admin only from seller messages the admin has not read', () => {
    const summaries = summarizeAdminThreads([
      msg({ sellerId: 's1', fromRole: 'seller', readByAdmin: false }),
      msg({ sellerId: 's1', fromRole: 'seller', readByAdmin: true }),
      msg({ sellerId: 's1', fromRole: 'admin', readByAdmin: false }), // admin's own — never counts
    ]);
    expect(summaries[0]!.unreadForAdmin).toBe(1);
  });
});
