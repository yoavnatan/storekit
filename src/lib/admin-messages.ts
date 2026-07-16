import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ADMIN_MESSAGES_PATH = path.join(process.cwd(), 'data/admin-messages.json');

// One flat conversation per seller (not subject-based threads like the
// buyer<->seller messages.ts) — the admin only ever has a single ongoing
// relationship with a given seller, so there's no need for a reply/root
// hierarchy here.
export interface AdminMessage {
  id: string;
  sellerId: string;
  fromRole: 'admin' | 'seller';
  content: string;
  readByAdmin: boolean;
  readBySeller: boolean;
  createdAt: string;
}

function readAdminMessages(): AdminMessage[] {
  try { return JSON.parse(fs.readFileSync(ADMIN_MESSAGES_PATH, 'utf8')) as AdminMessage[]; }
  catch { return []; }
}

function writeAdminMessages(messages: AdminMessage[]): void {
  fs.writeFileSync(ADMIN_MESSAGES_PATH, JSON.stringify(messages, null, 2));
}

export function createAdminMessage(sellerId: string, fromRole: 'admin' | 'seller', content: string): AdminMessage {
  const messages = readAdminMessages();
  const msg: AdminMessage = {
    id: crypto.randomUUID(),
    sellerId,
    fromRole,
    content,
    // the sender has obviously "seen" their own message
    readByAdmin: fromRole === 'admin',
    readBySeller: fromRole === 'seller',
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  writeAdminMessages(messages);
  return msg;
}

export function getAdminMessagesForSeller(sellerId: string): AdminMessage[] {
  return readAdminMessages()
    .filter((m) => m.sellerId === sellerId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function markAdminMessagesReadByAdmin(sellerId: string): void {
  const messages = readAdminMessages();
  let changed = false;
  messages.forEach((m) => { if (m.sellerId === sellerId && !m.readByAdmin) { m.readByAdmin = true; changed = true; } });
  if (changed) writeAdminMessages(messages);
}

export function markAdminMessagesReadBySeller(sellerId: string): void {
  const messages = readAdminMessages();
  let changed = false;
  messages.forEach((m) => { if (m.sellerId === sellerId && !m.readBySeller) { m.readBySeller = true; changed = true; } });
  if (changed) writeAdminMessages(messages);
}

export function getUnreadCountForSellerFromAdmin(sellerId: string): number {
  return readAdminMessages().filter((m) => m.sellerId === sellerId && m.fromRole === 'admin' && !m.readBySeller).length;
}

export interface AdminThreadSummary {
  sellerId: string;
  lastMessage: AdminMessage;
  unreadForAdmin: number;
}

// Groups every message by seller for the admin inbox view — most recently
// active conversation first. Pure/exported separately from the file read so
// it can be unit-tested without touching the filesystem.
export function summarizeAdminThreads(messages: AdminMessage[]): AdminThreadSummary[] {
  const bySeller = new Map<string, AdminMessage[]>();
  for (const m of messages) {
    const list = bySeller.get(m.sellerId) ?? [];
    list.push(m);
    bySeller.set(m.sellerId, list);
  }
  return [...bySeller.entries()]
    .map(([sellerId, msgs]) => {
      const sorted = [...msgs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return {
        sellerId,
        lastMessage: sorted[0]!,
        unreadForAdmin: msgs.filter((m) => m.fromRole === 'seller' && !m.readByAdmin).length,
      };
    })
    .sort((a, b) => new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime());
}

export function getAdminThreadSummaries(): AdminThreadSummary[] {
  return summarizeAdminThreads(readAdminMessages());
}

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

// summarizeAdminThreads already sorts by recency (its own default) — this
// only re-sorts when the toolbar asks for unread-first, and applies the
// unread-only filter. Kept separate from summarizeAdminThreads (which stays
// the pure grouping step) so filtering/sorting can be unit-tested against a
// plain AdminThreadSummary[] without needing raw AdminMessage[] fixtures.
export function filterAndSortAdminThreads(threads: AdminThreadSummary[], query: AdminThreadQuery): AdminThreadSummary[] {
  const filtered = query.unreadOnly ? threads.filter((t) => t.unreadForAdmin > 0) : threads;
  if (query.sortCol !== 'unread') return filtered;
  return [...filtered].sort((a, b) => {
    if (a.unreadForAdmin > 0 !== b.unreadForAdmin > 0) return a.unreadForAdmin > 0 ? -1 : 1;
    return new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime();
  });
}
