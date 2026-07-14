export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import {
  getNotificationsForUser,
  getUnreadCountForUser,
  markNotificationRead,
  markAllReadForUser,
  deleteNotificationsByRelatedIds,
  deleteNotification,
  deleteAllNotificationsForUser,
} from '../../lib/notifications.js';

export const GET: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const since = url.searchParams.get('since') ?? undefined;
  const notifications = getNotificationsForUser(userId, since);
  const unreadCount = getUnreadCountForUser(userId);

  return new Response(JSON.stringify({ notifications, unreadCount }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const body = await request.json() as { action: string; id?: string; relatedId?: string };

  if (body.action === 'mark-all-read') {
    markAllReadForUser(userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'mark-read' && body.id) {
    const ok = markNotificationRead(body.id, userId);
    return new Response(JSON.stringify({ ok }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete-by-related' && body.relatedId) {
    deleteNotificationsByRelatedIds([body.relatedId], userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete' && body.id) {
    const ok = deleteNotification(body.id, userId);
    return new Response(JSON.stringify({ ok }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete-all') {
    deleteAllNotificationsForUser(userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
};
