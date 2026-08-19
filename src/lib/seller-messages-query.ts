import type { Message } from './messages.js';
import type { AdminThread } from './admin-messages.js';
import { senderHasAccount } from './guest-sender.js';
import { decodeList } from './admin-nav.js';

// Server-side counterpart of the seller dashboard's Messages tab toolbar
// (src/scripts/dashboard/messages.ts) — pagination means the toolbar can no
// longer just show/hide DOM rows already on the page, so search+sort+filter
// run here over the full thread list before slicing to a page.
//
// Both message sources normalize to ONE row shape (SellerThreadRow): a
// buyer<->seller thread and an admin<->seller "system" thread are the same
// kind of object to the table, differing only in `kind` (which decides the
// API a reply/mark-read goes to) — that's what makes a system message read
// and behave exactly like a message from a buyer, instead of the permanently
// pinned single row it used to be (CURRENT_TASK "סשן ד׳").
export type SellerMessageSortCol = 'date' | 'unread' | 'product';
export type SellerMessageSortDir = 'asc' | 'desc';

// Sender label for admin<->seller threads — the seller has no per-person
// identity for the platform side, so every system thread shares one name
// (it's also the value the "שולח" filter offers for them).
export const SYSTEM_SENDER_LABEL = 'מערכת';

export interface SellerMessageQuery {
  q: string;
  sortCol: SellerMessageSortCol;
  sortDir: SellerMessageSortDir;
  status: string[];   // 'unread' | 'read'
  product: string[];  // product name, or '' sentinel for "no product"
  from: string[];      // sender name
}

const VALID_SORT_COLS = new Set<string>(['date', 'unread', 'product']);

export function parseSellerMessageQuery(sp: URLSearchParams): SellerMessageQuery {
  const [rawCol, rawDir] = (sp.get('msort') ?? 'date:desc').split(':');
  const sortCol = (VALID_SORT_COLS.has(rawCol ?? '') ? rawCol : 'date') as SellerMessageSortCol;
  const sortDir: SellerMessageSortDir = rawDir === 'asc' ? 'asc' : 'desc';
  return {
    q: (sp.get('mq') ?? '').trim(),
    sortCol,
    sortDir,
    status: decodeList(sp.get('mstatus') ?? ''),
    product: decodeList(sp.get('mproduct') ?? ''),
    from: decodeList(sp.get('mfrom') ?? ''),
  };
}

export interface SellerThreadEntry {
  who: string;      // display name of the writer
  fromSelf: boolean; // written by this seller
  content: string;
  createdAt: string;
  unread: boolean;   // incoming + not yet read by the seller
}

export interface SellerThreadRow {
  kind: 'buyer' | 'system';
  id: string;                // thread id = root message id
  fromName: string;
  subject: string;
  entries: SellerThreadEntry[]; // full thread, chronological (root first)
  lastContent: string;
  lastCreatedAt: string;
  lastFromSelf: boolean;
  hasUnread: boolean;
  productName: string;       // '' when the thread isn't about a product
  productHref: string;
  /** True when the person who opened this thread has no account — a guest who asked about their
   *  own order from the signed link in an order mail.
   *
   *  It changes what a REPLY does, which is why the seller has to be told: there is no screen for
   *  a guest to read an answer on, so the platform mails it to the address the order was placed
   *  with, with the seller's own address as the reply-to. From that point the conversation is two
   *  people's mailboxes and nothing comes back into this thread. A seller who writes "see the link
   *  below" or waits for an answer here has been misled by a box that looks like every other one. */
  replyGoesByEmail: boolean;
}

export function buildSellerMessageRows(messages: Message[], repliesByMsgId: Record<string, Message[]>, sellerId: string): SellerThreadRow[] {
  return messages.map((msg) => {
    const replies = repliesByMsgId[msg.id] ?? [];
    const entries: SellerThreadEntry[] = [
      { who: msg.fromName, fromSelf: false, content: msg.content, createdAt: msg.createdAt, unread: !msg.readBySeller },
      ...replies.map((r) => {
        const fromSelf = r.fromUserId === sellerId;
        return { who: fromSelf ? 'אתה' : r.fromName, fromSelf, content: r.content, createdAt: r.createdAt, unread: !fromSelf && !r.readBySeller };
      }),
    ];
    const last = entries[entries.length - 1]!;
    return {
      kind: 'buyer' as const,
      id: msg.id,
      fromName: msg.fromName,
      subject: msg.subject,
      entries,
      lastContent: last.content,
      lastCreatedAt: last.createdAt,
      lastFromSelf: last.fromSelf,
      hasUnread: entries.some((e) => e.unread),
      productName: msg.productRef?.productName ?? '',
      productHref: msg.productRef ? `/${msg.productRef.storeSlug}/${msg.productRef.productSlug}` : '',
      // Asked of the ROOT: the thread's counterparty is whoever opened it, and a reply always goes
      // back to them. `senderHasAccount` is the one definition (`messages.ts`), shared with the
      // reply endpoint that decides between a notification and a letter.
      replyGoesByEmail: !senderHasAccount(msg.fromUserId),
    };
  });
}

export function buildSystemMessageRows(threads: AdminThread[]): SellerThreadRow[] {
  return threads.map((t) => {
    const entries: SellerThreadEntry[] = t.messages.map((m) => {
      const fromSelf = m.fromRole === 'seller';
      return { who: fromSelf ? 'אתה' : SYSTEM_SENDER_LABEL, fromSelf, content: m.content, createdAt: m.createdAt, unread: !fromSelf && !m.readBySeller };
    });
    const last = entries[entries.length - 1]!;
    return {
      kind: 'system' as const,
      id: t.id,
      fromName: SYSTEM_SENDER_LABEL,
      subject: t.subject,
      entries,
      lastContent: last.content,
      lastCreatedAt: last.createdAt,
      lastFromSelf: last.fromSelf,
      hasUnread: t.unreadForSeller > 0,
      productName: '',
      productHref: '',
      // An admin thread always has an admin on the other end, and the admin has a screen.
      replyGoesByEmail: false,
    };
  });
}

export function filterAndSortSellerMessages(rows: SellerThreadRow[], query: SellerMessageQuery): SellerThreadRow[] {
  const statusSet = query.status.length ? new Set(query.status) : null;
  const productSet = query.product.length ? new Set(query.product) : null;
  const fromSet = query.from.length ? new Set(query.from) : null;
  const q = query.q.toLowerCase();

  const filtered = rows.filter((row) => {
    if (statusSet && !statusSet.has(row.hasUnread ? 'unread' : 'read')) return false;
    if (productSet && !productSet.has(row.productName)) return false;
    if (fromSet && !fromSet.has(row.fromName)) return false;
    if (q) {
      const haystack = `${row.fromName} ${row.subject} ${row.entries.map((e) => e.content).join(' ')} ${row.productName}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    let cmp: number;
    switch (query.sortCol) {
      case 'unread':  cmp = Number(a.hasUnread) - Number(b.hasUnread); break;
      case 'product': cmp = a.productName.localeCompare(b.productName, 'he'); break;
      default:        cmp = a.lastCreatedAt < b.lastCreatedAt ? -1 : a.lastCreatedAt > b.lastCreatedAt ? 1 : 0;
    }
    return cmp * dir;
  });
}
