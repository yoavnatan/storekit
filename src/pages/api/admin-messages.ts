export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import {
  getAdminThreadById,
  getUnreadAdminThreadIdsForSeller,
  markAdminThreadReadBySeller,
  replyToAdminThread,
  MAX_ADMIN_CONTENT_LEN,
} from '../../lib/admin-messages.js';

const json = { 'Content-Type': 'application/json' };

// Seller's view of the admin<->seller "system" threads. Every call is scoped
// to one thread id and re-checks that the thread belongs to THIS seller — a
// thread id from another seller's inbox must never resolve here.
export const GET: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: json });

  const sp = new URL(request.url).searchParams;
  if (sp.get('unread') === '1') {
    const unreadThreadIds = await getUnreadAdminThreadIdsForSeller(sellerId);
    return new Response(JSON.stringify({ unreadThreadIds, unreadCount: unreadThreadIds.length }), { headers: json });
  }

  const threadId = sp.get('threadId') ?? '';
  const thread = await getAdminThreadById(threadId);
  if (!thread || thread.sellerId !== sellerId) {
    return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
  }
  return new Response(JSON.stringify({ messages: thread.messages }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: json });

  const read = await readJsonBody<Record<string, unknown>>(request, BODY_LIMIT.form);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: read.status, headers: json });
  const body = read.value;

  const threadId = String(body.threadId ?? '');
  const thread = await getAdminThreadById(threadId);
  if (!thread || thread.sellerId !== sellerId) {
    return new Response(JSON.stringify({ error: 'Thread not found' }), { status: 404, headers: json });
  }

  if (body.action === 'mark-read') {
    await markAdminThreadReadBySeller(threadId, sellerId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  const content = String(body.content ?? '').trim();
  if (!content || content.length > MAX_ADMIN_CONTENT_LEN) {
    return new Response(JSON.stringify({ error: 'Invalid content' }), { status: 400, headers: json });
  }

  const message = await replyToAdminThread(threadId, 'seller', content);
  return new Response(JSON.stringify({ ok: true, message }), { headers: json });
};
