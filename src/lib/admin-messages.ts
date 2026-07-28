import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ADMIN_MESSAGES_PATH = path.join(process.cwd(), 'data/admin-messages.json');

// Admin<->seller messages are subject-based threads, exactly like the
// buyer<->seller ones in messages.ts (CURRENT_TASK "סשן ד׳"): the admin opens
// a thread with a subject, the seller replies inside it. They used to be ONE
// flat per-seller conversation surfaced as a permanently pinned "הודעות
// מערכת" row in the seller's messages table — that row existed even for a
// seller who never got a system message, and unrelated notices (a block
// notice, a question, a policy change) all piled into the same bubble list.
// Thread identity = the root message's id (`replyToId ?? id`).
export interface AdminMessage {
  id: string;
  sellerId: string;
  fromRole: 'admin' | 'seller';
  content: string;
  subject?: string;    // root message only
  replyToId?: string;  // reply -> root message id
  readByAdmin: boolean;
  readBySeller: boolean;
  createdAt: string;
}

// Pre-thread rows (and any row whose root was removed) carry no subject —
// they still render as a thread of their own rather than disappearing.
export const DEFAULT_ADMIN_SUBJECT = 'הודעת מערכת';

// Size caps, enforced by BOTH message APIs. The compose form's own
// maxlength is a convenience for the admin, not a control — a seller's
// reply reaches the same JSON store over a plain fetch, so the limit has to
// live server-side to mean anything.
export const MAX_ADMIN_SUBJECT_LEN = 120;
export const MAX_ADMIN_CONTENT_LEN = 5000;

export interface AdminThread {
  id: string;              // = root message id
  sellerId: string;
  subject: string;
  root: AdminMessage;
  messages: AdminMessage[]; // root first, then replies, chronological
  lastMessage: AdminMessage;
  unreadForAdmin: number;
  unreadForSeller: number;
}

function readAdminMessages(): AdminMessage[] {
  try { return JSON.parse(fs.readFileSync(ADMIN_MESSAGES_PATH, 'utf8')) as AdminMessage[]; }
  catch { return []; }
}

function writeAdminMessages(messages: AdminMessage[]): void {
  fs.writeFileSync(ADMIN_MESSAGES_PATH, JSON.stringify(messages, null, 2));
}

function threadIdOf(m: AdminMessage): string {
  return m.replyToId ?? m.id;
}

// Pure/exported separately from the file read so it can be unit-tested
// without touching the filesystem. Threads come out most-recently-active
// first — the order both inboxes (admin + seller) render in.
export function groupAdminThreads(messages: AdminMessage[]): AdminThread[] {
  const byThread = new Map<string, AdminMessage[]>();
  for (const m of messages) {
    const key = threadIdOf(m);
    const list = byThread.get(key) ?? [];
    list.push(m);
    byThread.set(key, list);
  }
  return [...byThread.entries()]
    .map(([id, msgs]) => {
      const sorted = [...msgs].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      // A reply whose root was deleted still needs a root to render from —
      // fall back to the oldest message in the group rather than dropping it.
      const root = sorted.find((m) => m.id === id) ?? sorted[0]!;
      return {
        id,
        sellerId: root.sellerId,
        subject: root.subject?.trim() || DEFAULT_ADMIN_SUBJECT,
        root,
        messages: sorted,
        lastMessage: sorted[sorted.length - 1]!,
        unreadForAdmin: sorted.filter((m) => m.fromRole === 'seller' && !m.readByAdmin).length,
        unreadForSeller: sorted.filter((m) => m.fromRole === 'admin' && !m.readBySeller).length,
      };
    })
    .sort((a, b) => (a.lastMessage.createdAt < b.lastMessage.createdAt ? 1 : a.lastMessage.createdAt > b.lastMessage.createdAt ? -1 : 0));
}

export function getAllAdminThreads(): AdminThread[] {
  return groupAdminThreads(readAdminMessages());
}

export function getAdminThreadsForSeller(sellerId: string): AdminThread[] {
  return groupAdminThreads(readAdminMessages().filter((m) => m.sellerId === sellerId));
}

export function getAdminThreadById(threadId: string): AdminThread | null {
  const messages = readAdminMessages().filter((m) => threadIdOf(m) === threadId);
  if (messages.length === 0) return null;
  return groupAdminThreads(messages)[0] ?? null;
}

// Only the admin opens a thread — a seller never starts one (there is no
// "contact the platform" entry point by design; zero-touch self-service).
// The seller's reply inside an existing thread IS the appeal/response channel.
export function createAdminThread(sellerId: string, subject: string, content: string): AdminMessage {
  const messages = readAdminMessages();
  const msg: AdminMessage = {
    id: crypto.randomUUID(),
    sellerId,
    fromRole: 'admin',
    content,
    subject: subject.trim() || DEFAULT_ADMIN_SUBJECT,
    readByAdmin: true,   // the sender has obviously "seen" their own message
    readBySeller: false,
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  writeAdminMessages(messages);
  return msg;
}

export function replyToAdminThread(threadId: string, fromRole: 'admin' | 'seller', content: string): AdminMessage | null {
  const messages = readAdminMessages();
  const root = messages.find((m) => m.id === threadId);
  if (!root) return null;
  const msg: AdminMessage = {
    id: crypto.randomUUID(),
    sellerId: root.sellerId,
    fromRole,
    content,
    replyToId: threadId,
    readByAdmin: fromRole === 'admin',
    readBySeller: fromRole === 'seller',
    createdAt: new Date().toISOString(),
  };
  messages.push(msg);
  writeAdminMessages(messages);
  return msg;
}

// Admin-only: removes the root and every reply under it, for BOTH sides.
// A system thread is the platform's own record (a block notice and the
// seller's appeal to it), so the seller can't delete one — only the admin,
// who owns that record, can. Returns false when the thread is already gone.
export function deleteAdminThread(threadId: string): boolean {
  const messages = readAdminMessages();
  const remaining = messages.filter((m) => threadIdOf(m) !== threadId);
  if (remaining.length === messages.length) return false;
  writeAdminMessages(remaining);
  return true;
}

function markThreadRead(threadId: string, reader: 'admin' | 'seller', guard?: (m: AdminMessage) => boolean): void {
  const messages = readAdminMessages();
  let changed = false;
  messages.forEach((m) => {
    if (threadIdOf(m) !== threadId) return;
    if (guard && !guard(m)) return;
    if (reader === 'admin' && !m.readByAdmin) { m.readByAdmin = true; changed = true; }
    if (reader === 'seller' && !m.readBySeller) { m.readBySeller = true; changed = true; }
  });
  if (changed) writeAdminMessages(messages);
}

export function markAdminThreadReadByAdmin(threadId: string): void {
  markThreadRead(threadId, 'admin');
}

// sellerId is a guard, not a lookup — a seller may only mark their OWN
// thread read, so a forged threadId from another seller's inbox is a no-op.
export function markAdminThreadReadBySeller(threadId: string, sellerId: string): void {
  markThreadRead(threadId, 'seller', (m) => m.sellerId === sellerId);
}

export function getUnreadCountForSellerFromAdmin(sellerId: string): number {
  return readAdminMessages().filter((m) => m.sellerId === sellerId && m.fromRole === 'admin' && !m.readBySeller).length;
}

// Thread ids with at least one unread admin message — what the seller
// dashboard's live poll flags per row (it can no longer use a single count,
// now that system messages are many rows instead of one pinned one).
export function getUnreadAdminThreadIdsForSeller(sellerId: string): string[] {
  return readAdminMessages()
    .filter((m) => m.sellerId === sellerId && m.fromRole === 'admin' && !m.readBySeller)
    .map(threadIdOf);
}
