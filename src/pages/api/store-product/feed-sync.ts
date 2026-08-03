export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { syncStoreFeed } from '../../../lib/store-feed-sync.js';

// "Sync now": the seller-pressed half of the external-inventory pull. Everything this route does is
// what only a route can do — authenticate the session, prove the seller owns the store named in the
// body, read that body under a cap. The pull itself (fetch behind the SSRF guard → re-apply the
// saved column mapping → run the same import a manual upload runs) is `lib/store-feed-sync.ts`,
// because the scheduler's `feed-sync` job runs the identical sequence with no session to present
// (DB_MIGRATION_PLAN.md §8 stage 4a). Two calls from the dashboard: commit:false for the preview,
// commit:true to write.

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const read = await readJsonBody<{ storeId?: string; commit?: boolean }>(request, BODY_LIMIT.control);
  if (!read.ok) return json({ ok: false, error: 'Invalid body' }, read.status);
  const body = read.value;
  const store = (await getStoresBySellerId(sellerId)).find((s) => s.id === (body.storeId ?? ''));
  if (!store) return json({ ok: false, error: 'Not authorized' }, 403);

  const { status, body: resBody } = await syncStoreFeed(store, !!body.commit);
  return json(resBody, status);
};
