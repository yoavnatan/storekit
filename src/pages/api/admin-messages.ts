export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import {
  createAdminMessage,
  getAdminMessagesForSeller,
  markAdminMessagesReadBySeller,
  getUnreadCountForSellerFromAdmin,
} from '../../lib/admin-messages.js';

const json = { 'Content-Type': 'application/json' };

export const GET: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: json });

  if (new URL(request.url).searchParams.get('unread') === '1') {
    return new Response(JSON.stringify({ unreadCount: getUnreadCountForSellerFromAdmin(sellerId) }), { headers: json });
  }
  return new Response(JSON.stringify({ messages: getAdminMessagesForSeller(sellerId) }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: json });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: json }); }

  if (body.action === 'mark-read') {
    markAdminMessagesReadBySeller(sellerId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  const content = String(body.content ?? '').trim();
  if (!content) return new Response(JSON.stringify({ error: 'Missing content' }), { status: 400, headers: json });

  const message = createAdminMessage(sellerId, 'seller', content);
  return new Response(JSON.stringify({ message }), { headers: json });
};
