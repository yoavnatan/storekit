export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import {
  getNotificationsForUser,
  getNotificationsPage,
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

  // **Paged mode — the bell's "הצג עוד", and it is a SEPARATE branch on purpose.** The default
  // response is what the header polls every 30 seconds on every open tab, so nothing may be added
  // to its cost; `hasMore` is asked for only by the click that needs the answer. Additive, per the
  // backward-compatible-API rule: a deploy that predates this ignores the parameters and a browser
  // running the old script never sends them.
  const offsetParam = url.searchParams.get('offset');
  if (offsetParam !== null) {
    // Nothing is validated here on purpose: the page size and the "is there more" probe have to
    // agree, and `getNotificationsPage` is the one place that can see both. It clamps whatever
    // arrives, so a hand-typed `?offset=abc&limit=-3` answers page one rather than 500.
    const { notifications: page, hasMore } = await getNotificationsPage(
      userId,
      Number(offsetParam),
      Number(url.searchParams.get('limit') ?? 10),
    );
    const withHrefPage = page.map((n) => ({ ...n, href: notificationHref(n) }));
    return new Response(JSON.stringify({ notifications: withHrefPage, hasMore }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
