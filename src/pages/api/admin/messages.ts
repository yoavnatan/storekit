export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import {
  createAdminThread,
  deleteAdminThread,
  getAdminThreadById,
  getAllAdminThreads,
  markAdminThreadReadByAdmin,
  replyToAdminThread,
  MAX_ADMIN_CONTENT_LEN,
  MAX_ADMIN_SUBJECT_LEN,
} from '../../../lib/admin-messages.js';
import { createNotification, deleteNotificationsByRelatedIds } from '../../../lib/notifications.js';
import { getSellerById } from '../../../lib/seller-auth.js';

const json = { 'Content-Type': 'application/json' };

// relatedId is the THREAD id, not the message id — it's what the header's
// notification deep-link matches against a dashboard row's data-msg-id.
function notifySeller(sellerId: string, subject: string, content: string, threadId: string): void {
  createNotification({
    userId: sellerId,
    role: 'seller',
    type: 'admin_message',
    title: subject,
    body: content.slice(0, 120),
    relatedId: threadId,
  });
}

export const GET: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const threadId = new URL(request.url).searchParams.get('threadId');
  if (threadId) {
    const thread = getAdminThreadById(threadId);
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    return new Response(JSON.stringify({ messages: thread.messages }), { headers: json });
  }
  return new Response(JSON.stringify({ threads: getAllAdminThreads() }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: json }); }

  const threadId = String(body.threadId ?? '');

  if (body.action === 'mark-read') {
    if (!threadId || !getAdminThreadById(threadId)) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    }
    markAdminThreadReadByAdmin(threadId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  // Deleting is admin-only and removes the thread for both sides — the
  // seller's notification for it goes too, otherwise the header would keep
  // deep-linking to a conversation that no longer exists.
  if (body.action === 'delete') {
    const thread = threadId ? getAdminThreadById(threadId) : null;
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    deleteAdminThread(threadId);
    deleteNotificationsByRelatedIds([threadId], thread.sellerId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  const content = String(body.content ?? '').trim();
  if (!content || content.length > MAX_ADMIN_CONTENT_LEN) {
    return new Response(JSON.stringify({ error: 'Invalid content' }), { status: 400, headers: json });
  }

  // Reply inside an existing thread…
  if (threadId) {
    const thread = getAdminThreadById(threadId);
    if (!thread) return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
    const message = replyToAdminThread(threadId, 'admin', content)!;
    notifySeller(thread.sellerId, thread.subject, content, threadId);
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

  const message = createAdminThread(sellerId, subject, content);
  notifySeller(sellerId, subject, content, message.id);
  return new Response(JSON.stringify({ ok: true, message, threadId: message.id }), { headers: json });
};
