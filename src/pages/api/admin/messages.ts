export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import {
  createAdminMessage,
  getAdminMessagesForSeller,
  getAdminThreadSummaries,
  markAdminMessagesReadByAdmin,
} from '../../../lib/admin-messages.js';
import { createNotification } from '../../../lib/notifications.js';
import { getSellerById } from '../../../lib/seller-auth.js';

const json = { 'Content-Type': 'application/json' };

export const GET: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const sellerId = new URL(request.url).searchParams.get('sellerId');
  if (sellerId) {
    return new Response(JSON.stringify({ messages: getAdminMessagesForSeller(sellerId) }), { headers: json });
  }
  return new Response(JSON.stringify({ threads: getAdminThreadSummaries() }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: json }); }

  if (body.action === 'mark-read') {
    const sellerId = String(body.sellerId ?? '');
    if (!sellerId || !getSellerById(sellerId)) {
      return new Response(JSON.stringify({ error: 'Seller not found' }), { status: 404, headers: json });
    }
    markAdminMessagesReadByAdmin(sellerId);
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }

  const sellerId = String(body.sellerId ?? '');
  const content = String(body.content ?? '').trim();
  if (!sellerId || !content) {
    return new Response(JSON.stringify({ error: 'Missing sellerId or content' }), { status: 400, headers: json });
  }
  const seller = getSellerById(sellerId);
  if (!seller) return new Response(JSON.stringify({ error: 'Seller not found' }), { status: 404, headers: json });

  const message = createAdminMessage(sellerId, 'admin', content);
  createNotification({
    userId: sellerId,
    role: 'seller',
    type: 'admin_message',
    title: 'הודעת מערכת חדשה',
    body: content.slice(0, 120),
    relatedId: message.id,
  });

  return new Response(JSON.stringify({ message }), { headers: json });
};
