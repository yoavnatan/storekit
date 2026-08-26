export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getAllLastViewedAt } from '../../../lib/admin-tab-views.js';
import { getAdminNotifications, unreadCount } from '../../../lib/admin-notifications.js';

/**
 * What the admin bell polls.
 *
 * **Guarded by `requireAdmin` before anything is read**, and that is not a formality: the feed
 * carries every seller's name, every buyer's name, the subject line of every unhandled enquiry and
 * the text of every unresolved error on the platform. It is the single widest read on the site
 * after the dashboard itself.
 *
 * `?since=` is the poller's cursor and is the whole difference between "what is new" and "what is
 * there". The seller-side poller in `BaseLayout.astro` works the same way and its header explains
 * the two traps this inherits: the cursor is anchored to the newest row's own `createdAt` rather
 * than to the client's clock, and it lives in `localStorage` so a page reload does not re-toast a
 * backlog. Both are the CALLER's job — this route just answers honestly for the window it is given.
 *
 * `unreadCount` is computed from the very list being returned rather than by a second query, so the
 * number on the bell and the rows behind it cannot disagree. On a `since=` poll that number is
 * about the new window only; the browser keeps the badge from the full fetch, exactly as the
 * seller's bell does.
 *
 * `no-store`, because the answer changes with every order and every error, and a cached one is a
 * dashboard confidently reporting a quiet minute that was not quiet.
 */
function json(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const since = new URL(request.url).searchParams.get('since');
  // Validated as a date rather than passed through: it reaches a `timestamptz` cast, and an
  // unparseable string there is a 500 on a poll that runs every fifteen seconds. Nothing is lost by
  // treating a bad cursor as no cursor — the caller gets the full list and its own dedup handles
  // the rest.
  const cursor = since && !Number.isNaN(Date.parse(since)) ? since : undefined;

  const items = await getAdminNotifications(await getAllLastViewedAt(), cursor);
  return json({ notifications: items, unreadCount: unreadCount(items) });
}
