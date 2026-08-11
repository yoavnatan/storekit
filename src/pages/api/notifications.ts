export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
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
import { notificationHref } from '../../lib/notification-link.js';

export const GET: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const url = new URL(request.url);
  const since = url.searchParams.get('since') ?? undefined;
  const [notifications, unreadCount] = await Promise.all([
    getNotificationsForUser(userId, since),
    getUnreadCountForUser(userId),
  ]);

  // `href` is derived, never stored: it is where clicking this row should land, computed once here
  // so the dropdown and the toast poller cannot disagree about it (notification-link.ts).
  const withHref = notifications.map((n) => ({ ...n, href: notificationHref(n) }));

  return new Response(JSON.stringify({ notifications: withHref, unreadCount }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  const read = await readJsonBody<{ action: string; id?: string; relatedId?: string }>(request, BODY_LIMIT.control);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid body' }), { status: read.status });
  const body = read.value;

  if (body.action === 'mark-all-read') {
    await markAllReadForUser(userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'mark-read' && body.id) {
    const ok = await markNotificationRead(body.id, userId);
    return new Response(JSON.stringify({ ok }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete-by-related' && body.relatedId) {
    await deleteNotificationsByRelatedIds([body.relatedId], userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete' && body.id) {
    const ok = await deleteNotification(body.id, userId);
    return new Response(JSON.stringify({ ok }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (body.action === 'delete-all') {
    await deleteAllNotificationsForUser(userId);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
};
