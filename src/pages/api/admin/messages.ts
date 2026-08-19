export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import {
  createAdminThread,
  deleteAdminThread,
  getAdminThreadById,
  getAdminThreadsPage,
  markAdminThreadReadByAdmin,
  replyToAdminThread,
  MAX_ADMIN_CONTENT_LEN,
  MAX_ADMIN_SUBJECT_LEN,
} from '../../../lib/admin-messages.js';
import { createNotification, deleteNotificationsByRelatedIds } from '../../../lib/notifications.js';
import { getSellerById } from '../../../lib/seller-auth.js';
import { withTransaction, type Queryable } from '../../../lib/db.js';
import { ADMIN_PAGE_SIZE } from '../../../lib/pagination.js';

const json = { 'Content-Type': 'application/json' };

// relatedId is the THREAD id, not the message id — it's what the header's
// notification deep-link matches against a dashboard row's data-msg-id.
async function notifySeller(sellerId: string, subject: string, content: string, threadId: string, tx?: Queryable): Promise<void> {
  await createNotification({
    userId: sellerId,
    role: 'seller',
    type: 'admin_message',
    title: subject,
    body: content.slice(0, 120),
    relatedId: threadId,
  }, tx);
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const threadId = new URL(request.url).searchParams.get('threadId');
  if (threadId) {
    const thread = await getAdminThreadById(threadId);
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    return new Response(JSON.stringify({ messages: thread.messages }), { headers: json });
  }
  // The newest page of threads, not all of them (§3, 2026-08-03). Its only caller is the Messages
  // tab's poll, and it acts on exactly two kinds of thread: one already in the page's DOM that has
  // a new message, and — on page 1 — one that is brand new. Both are, by definition, at the top of
  // the recency order the moment they change, so a page of the most recently active threads is
  // everything the poll can use. It used to fetch every system message on the platform, with every
  // thread's full message array, on a timer.
  const page = await getAdminThreadsPage({ sortCol: 'recent', unreadOnly: false, role: 'all', status: 'all' }, 1, ADMIN_PAGE_SIZE);
  return new Response(JSON.stringify({ threads: page.threads }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: read.status, headers: json });
  const body = read.value;

  const threadId = String(body.threadId ?? '');

  if (body.action === 'mark-read') {
    if (!threadId || !(await getAdminThreadById(threadId))) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    }
    await markAdminThreadReadByAdmin(threadId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  // Deleting is admin-only and removes the thread for both sides — the
  // seller's notification for it goes too, otherwise the header would keep
  // deep-linking to a conversation that no longer exists.
  if (body.action === 'delete') {
    const thread = threadId ? await getAdminThreadById(threadId) : null;
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    await withTransaction(async (tx) => {
      await deleteAdminThread(threadId, tx);
      await deleteNotificationsByRelatedIds([threadId], thread.sellerId, tx);
    });
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  const content = String(body.content ?? '').trim();
  if (!content || content.length > MAX_ADMIN_CONTENT_LEN) {
    return new Response(JSON.stringify({ error: 'Invalid content' }), { status: 400, headers: json });
  }

  // Reply inside an existing thread…
  if (threadId) {
    const thread = await getAdminThreadById(threadId);
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    // One transaction, same reason as the buyer↔seller side: a system message with no notification
    // never reaches the seller's header, and a notification with no message deep-links to nothing.
    const message = await withTransaction(async (tx) => {
      const written = await replyToAdminThread(threadId, 'admin', content, tx);
      if (written) await notifySeller(thread.sellerId, thread.subject, content, threadId, tx);
      return written;
    });
    if (!message) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    return new Response(JSON.stringify({ ok: true, message, threadId }), { headers: json });
  }

  // …or open a new one, which is the only place a subject is set.
  const sellerId = String(body.sellerId ?? '');
  const subject = String(body.subject ?? '').trim();
  if (!sellerId || !subject || subject.length > MAX_ADMIN_SUBJECT_LEN) {
    return new Response(JSON.stringify({ error: 'Missing or invalid sellerId/subject' }), { status: 400, headers: json });
  }
  const seller = await getSellerById(sellerId);
  if (!seller) return new Response(JSON.stringify({ error: 'Seller not found' }), { status: 404, headers: json });

  const message = await withTransaction(async (tx) => {
    const written = await createAdminThread(sellerId, subject, content, tx);
    await notifySeller(sellerId, subject, content, written.id, tx);
    return written;
  });
  return new Response(JSON.stringify({ ok: true, message, threadId: message.id }), { headers: json });
};
