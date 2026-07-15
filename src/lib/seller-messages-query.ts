import type { Message } from './messages.js';
import { decodeList } from './admin-nav.js';

// Server-side counterpart of the seller dashboard's Messages tab toolbar
// (src/pages/seller/dashboard.astro's inline script) — pagination means the
// toolbar can no longer just show/hide DOM rows already on the page, so
// search+sort+filter run here over the full (buyer) message list before
// slicing to a page. The pinned "הודעות מערכת" row is a separate synthetic
// row rendered outside this pipeline entirely — not a real Message, and
// small/fixed enough (one thread) that pagination never applies to it.
export type SellerMessageSortCol = 'date' | 'unread' | 'product';
export type SellerMessageSortDir = 'asc' | 'desc';

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

export interface SellerMessageRow {
  msg: Message;
  replies: Message[];
  lastMsg: Message;
  hasUnread: boolean;
}

export function buildSellerMessageRows(messages: Message[], repliesByMsgId: Record<string, Message[]>, sellerId: string): SellerMessageRow[] {
  return messages.map((msg) => {
    const replies = repliesByMsgId[msg.id] ?? [];
    const hasUnread = !msg.readBySeller || replies.some((r) => r.toSellerId === sellerId && !r.readBySeller);
    const lastMsg = replies.length > 0 ? replies[replies.length - 1]! : msg;
    return { msg, replies, lastMsg, hasUnread };
  });
}

export function filterAndSortSellerMessages(rows: SellerMessageRow[], query: SellerMessageQuery): SellerMessageRow[] {
  const statusSet = query.status.length ? new Set(query.status) : null;
  const productSet = query.product.length ? new Set(query.product) : null;
  const fromSet = query.from.length ? new Set(query.from) : null;
  const q = query.q.toLowerCase();

  const filtered = rows.filter(({ msg, lastMsg, hasUnread }) => {
    if (statusSet && !statusSet.has(hasUnread ? 'unread' : 'read')) return false;
    if (productSet && !productSet.has(msg.productRef?.productName ?? '')) return false;
    if (fromSet && !fromSet.has(msg.fromName)) return false;
    if (q) {
      const haystack = `${msg.fromName} ${msg.subject} ${msg.content} ${lastMsg.content} ${msg.productRef?.productName ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const dir = query.sortDir === 'asc' ? 1 : -1;
  return [...filtered].sort((a, b) => {
    let cmp: number;
    switch (query.sortCol) {
      case 'unread':  cmp = Number(a.hasUnread) - Number(b.hasUnread); break;
      case 'product': cmp = (a.msg.productRef?.productName ?? '').localeCompare(b.msg.productRef?.productName ?? '', 'he'); break;
      default:        cmp = a.lastMsg.createdAt < b.lastMsg.createdAt ? -1 : a.lastMsg.createdAt > b.lastMsg.createdAt ? 1 : 0;
    }
    return cmp * dir;
  });
}
