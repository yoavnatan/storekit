export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { toggleFavoriteStore, countFavoriteStores } from '../../lib/user-carts.js';
import { getStoreBySlugOrPrevious } from '../../lib/stores.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';

export async function POST({ cookies, request }: APIContext): Promise<Response> {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const read = await readJsonBody<{ storeSlug?: unknown } | null>(request, BODY_LIMIT.control);
  if (!read.ok) return new Response('Bad request', { status: read.status });
  // Optional chaining, not a try/catch: `null` is valid JSON, and it used to reach this as a
  // TypeError that the catch below turned into the right answer for the wrong reason.
  const storeSlug = read.value?.storeSlug;
  if (typeof storeSlug !== 'string' || !storeSlug) return new Response('Bad request', { status: 400 });

  // Tolerate a previous slug (store URL renamed since the page loaded) and always store the CURRENT
  // slug — favorites are migrated to the current slug on rename, so this keeps toggles consistent.
  const store = await getStoreBySlugOrPrevious(storeSlug);
  if (!store) {
    return new Response('Store not found', { status: 404 });
  }

  // One row in, one row out — no read of the buyer's other state and no rewrite of it. The count
  // is asked of the store's id, not of the slug the request happened to name (which may be a
  // previous one); the answer is COUNT(*) on the table, so it cannot drift from what was written.
  const favorited = await toggleFavoriteStore(userId, store.id);

  return new Response(
    JSON.stringify({ favorited, count: await countFavoriteStores(store.id) }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
