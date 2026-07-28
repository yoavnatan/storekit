import { describe, expect, it } from 'vitest';
import {
  buildSellerMessageRows,
  buildSystemMessageRows,
  filterAndSortSellerMessages,
  parseSellerMessageQuery,
  SYSTEM_SENDER_LABEL,
  type SellerMessageQuery,
} from '../src/lib/seller-messages-query.js';
import { groupAdminThreads, type AdminMessage } from '../src/lib/admin-messages.js';
import type { Message } from '../src/lib/messages.js';

const SELLER = 'seller-1';

function buyerMsg(overrides: Partial<Message>): Message {
  return {
    id: 'b1',
    fromUserId: 'buyer-1',
    fromName: 'דנה',
    fromEmail: 'dana@example.com',
    toStoreId: 'store-1',
    toSellerId: SELLER,
    toStoreName: 'חנות',
    subject: 'שאלה על מידה',
    content: 'יש במלאי?',
    readBySeller: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function adminMsg(overrides: Partial<AdminMessage>): AdminMessage {
  return {
    id: 'a1',
    sellerId: SELLER,
    fromRole: 'admin',
    content: 'החנות נחסמה',
    subject: 'חסימת חנות',
    readByAdmin: true,
    readBySeller: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function query(overrides: Partial<SellerMessageQuery> = {}): SellerMessageQuery {
  return { q: '', sortCol: 'date', sortDir: 'desc', status: [], product: [], from: [], ...overrides };
}

function systemRows(messages: AdminMessage[]) {
  return buildSystemMessageRows(groupAdminThreads(messages));
}

describe('buildSystemMessageRows', () => {
  it('gives each admin thread its own row with its own subject', () => {
    const rows = systemRows([
      adminMsg({ id: 'a1', subject: 'חסימת חנות' }),
      adminMsg({ id: 'a2', subject: 'עדכון תנאי שימוש', createdAt: '2026-01-03T00:00:00.000Z' }),
    ]);
    expect(rows.map((r) => r.subject)).toEqual(['עדכון תנאי שימוש', 'חסימת חנות']);
    expect(rows.every((r) => r.kind === 'system' && r.fromName === SYSTEM_SENDER_LABEL)).toBe(true);
  });

  it('renders nothing at all when the seller has no system messages', () => {
    expect(systemRows([])).toEqual([]);
  });

  it('marks the row unread only for admin messages the seller has not read', () => {
    expect(systemRows([adminMsg({ readBySeller: false })])[0]!.hasUnread).toBe(true);
    // the seller's own reply is never "unread" for them
    const withOwnReply = systemRows([
      adminMsg({ id: 'a1' }),
      adminMsg({ id: 'r1', replyToId: 'a1', fromRole: 'seller', readBySeller: false, createdAt: '2026-01-04T00:00:00.000Z' }),
    ]);
    expect(withOwnReply[0]!.hasUnread).toBe(false);
    expect(withOwnReply[0]!.lastFromSelf).toBe(true);
  });
});

describe('filterAndSortSellerMessages over both kinds', () => {
  const rows = [
    ...buildSellerMessageRows([buyerMsg({ id: 'b1', createdAt: '2026-01-01T00:00:00.000Z' })], { b1: [] }, SELLER),
    ...systemRows([adminMsg({ id: 'a1', createdAt: '2026-01-03T00:00:00.000Z' })]),
  ];

  it('sorts system and buyer threads together by date, not pinned', () => {
    const desc = filterAndSortSellerMessages(rows, query());
    expect(desc.map((r) => r.id)).toEqual(['a1', 'b1']);
    const asc = filterAndSortSellerMessages(rows, query({ sortDir: 'asc' }));
    expect(asc.map((r) => r.id)).toEqual(['b1', 'a1']);
  });

  it('filters system threads by the sender label like any other sender', () => {
    const result = filterAndSortSellerMessages(rows, query({ from: [SYSTEM_SENDER_LABEL] }));
    expect(result.map((r) => r.id)).toEqual(['a1']);
  });

  it('searches system thread subjects and bodies', () => {
    expect(filterAndSortSellerMessages(rows, query({ q: 'חסימת' })).map((r) => r.id)).toEqual(['a1']);
    expect(filterAndSortSellerMessages(rows, query({ q: 'מלאי' })).map((r) => r.id)).toEqual(['b1']);
  });
});

describe('parseSellerMessageQuery', () => {
  it('falls back to date:desc for an unknown sort column', () => {
    const q = parseSellerMessageQuery(new URLSearchParams('msort=bogus:asc'));
    expect(q.sortCol).toBe('date');
    expect(q.sortDir).toBe('asc');
  });
});
