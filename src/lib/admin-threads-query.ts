import type { AdminThread, InquiryParty } from './admin-messages.js';

// Toolbar state for the admin dashboard's Messages tab. Split out of
// admin-messages.ts (which stays storage + thread grouping) so filtering and
// sorting can be unit-tested against a plain AdminThread[] without raw
// AdminMessage[] fixtures — same split as seller-messages-query.ts.
//
// **`role` and `status` arrived with the inbox merge (2026-08-19)**, when this list stopped being
// admin↔seller only: a buyer's question, a guest's fault report and a seller's enquiry now land in
// the same place, which is what the owner asked for and also what makes narrowing necessary. Two
// filters and no more — the tab is an inbox, and an inbox that needs a query builder to read is one
// nobody opens (*"שיהיה פשוט. לא עמוס בעין"*).
export type AdminThreadSortCol = 'recent' | 'unread';
export type AdminThreadRoleFilter = 'all' | InquiryParty;
export type AdminThreadStatusFilter = 'all' | 'open' | 'handled';

export interface AdminThreadQuery {
  sortCol: AdminThreadSortCol;
  unreadOnly: boolean;
  role: AdminThreadRoleFilter;
  status: AdminThreadStatusFilter;
}

export function parseAdminThreadQuery(sp: URLSearchParams): AdminThreadQuery {
  const requested = sp.get('msort');
  const role = sp.get('mrole');
  const status = sp.get('mstatus');
  return {
    sortCol: requested === 'unread' ? 'unread' : 'recent',
    unreadOnly: sp.get('munread') === '1',
    role: role === 'seller' || role === 'buyer' || role === 'guest' ? role : 'all',
    status: status === 'open' || status === 'handled' ? status : 'all',
  };
}

/** Is anything narrowed? Drives the toolbar's "נקה סינון", which is not offered when there is
 *  nothing to clear — a permanently visible clear button reads as an active filter. */
export function hasActiveThreadFilters(query: AdminThreadQuery): boolean {
  return query.unreadOnly || query.role !== 'all' || query.status !== 'all';
}

/** The toolbar's params, for `buildAdminUrl` — one place, so a pager link and a filter change can
 *  never disagree about which of them survives the other. */
export function threadQueryParams(query: AdminThreadQuery): Record<string, string | undefined> {
  return {
    msort: query.sortCol !== 'recent' ? query.sortCol : undefined,
    munread: query.unreadOnly ? '1' : undefined,
    mrole: query.role !== 'all' ? query.role : undefined,
    mstatus: query.status !== 'all' ? query.status : undefined,
  };
}

// groupAdminThreads already sorts by recency (its own default) — this only
// re-sorts when the toolbar asks for unread-first, and applies the filters.
//
// The pure twin of the SQL in `getAdminThreadsPage`: this is what
// `tests/admin-messages.test.ts` drives without a database, and the two are expected to agree.
export function filterAndSortAdminThreads(threads: AdminThread[], query: AdminThreadQuery): AdminThread[] {
  const filtered = threads.filter((t) =>
    (!query.unreadOnly || t.unreadForAdmin > 0)
    && (query.role === 'all' || t.partyRole === query.role)
    && (query.status === 'all' || t.status === query.status));
  if (query.sortCol !== 'unread') return filtered;
  return [...filtered].sort((a, b) => {
    if (a.unreadForAdmin > 0 !== b.unreadForAdmin > 0) return a.unreadForAdmin > 0 ? -1 : 1;
    return new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime();
  });
}
