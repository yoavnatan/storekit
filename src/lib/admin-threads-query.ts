import type { AdminThread } from './admin-messages.js';

// Toolbar state for the admin dashboard's Messages tab. Split out of
// admin-messages.ts (which stays storage + thread grouping) so filtering and
// sorting can be unit-tested against a plain AdminThread[] without raw
// AdminMessage[] fixtures — same split as seller-messages-query.ts.
export type AdminThreadSortCol = 'recent' | 'unread';

export interface AdminThreadQuery {
  sortCol: AdminThreadSortCol;
  unreadOnly: boolean;
}

export function parseAdminThreadQuery(sp: URLSearchParams): AdminThreadQuery {
  const requested = sp.get('msort');
  return {
    sortCol: requested === 'unread' ? 'unread' : 'recent',
    unreadOnly: sp.get('munread') === '1',
  };
}

// groupAdminThreads already sorts by recency (its own default) — this only
// re-sorts when the toolbar asks for unread-first, and applies the
// unread-only filter.
export function filterAndSortAdminThreads(threads: AdminThread[], query: AdminThreadQuery): AdminThread[] {
  const filtered = query.unreadOnly ? threads.filter((t) => t.unreadForAdmin > 0) : threads;
  if (query.sortCol !== 'unread') return filtered;
  return [...filtered].sort((a, b) => {
    if (a.unreadForAdmin > 0 !== b.unreadForAdmin > 0) return a.unreadForAdmin > 0 ? -1 : 1;
    return new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime();
  });
}
