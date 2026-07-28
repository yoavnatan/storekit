export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getMessagesBySeller, getMessageReplies } from '../../../lib/messages.js';
import { getAdminThreadsForSeller } from '../../../lib/admin-messages.js';
import { buildSellerMessageRows, buildSystemMessageRows, filterAndSortSellerMessages, parseSellerMessageQuery } from '../../../lib/seller-messages-query.js';
import { paginate, parsePage } from '../../../lib/pagination.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// AJAX pagination for the seller dashboard's Messages tab — buyer threads
// AND admin "system" threads, in one list. Mirrors the initial SSR render's
// own query/filter/sort/paginate pipeline in dashboard.astro exactly (the
// two must stay identical, or page 1 would differ from what SSR painted).
export const GET: APIRoute = async ({ url, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const storeId = url.searchParams.get('storeId') ?? '';
  const store = getStoresBySellerId(sellerId).find((s) => s.id === storeId);
  if (!store) return json({ ok: false, error: 'Not authorized' }, 403);

  const storeMessages = getMessagesBySeller(sellerId).filter((m) => !m.replyToId && m.toStoreId === store.id);
  const repliesByMsgId = Object.fromEntries(storeMessages.map((m) => [m.id, getMessageReplies(m.id)]));
  const rows = [
    ...buildSellerMessageRows(storeMessages, repliesByMsgId, sellerId),
    ...buildSystemMessageRows(getAdminThreadsForSeller(sellerId)),
  ];

  const query = parseSellerMessageQuery(url.searchParams);
  const filtered = filterAndSortSellerMessages(rows, query);
  const page = paginate(filtered, parsePage(url.searchParams, 'page'), 15);

  return json({
    ok: true,
    items: page.items,
    page: page.page,
    totalPages: page.totalPages,
    total: page.total,
  });
};
