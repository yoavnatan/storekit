export const prerender = false;
/**
 * Flag a product as one of the four its store's homepage card shows.
 *
 * Its own endpoint rather than a field on `/api/product`, and the reason is the cap: the per-store
 * ceiling is enforced inside `setProductFeatured`'s single UPDATE, and a caller that can also reach
 * this column through the general product PATCH would be able to set it without passing through
 * that statement. `PRODUCT_UPDATE_FIELDS` still lists `featured` because bulk edit and CSV import
 * build from that map, but the interactive path — the one a seller clicks — comes here.
 *
 * The response carries the store's resulting COUNT, not just the new state, so the dashboard can
 * render "2/4" without a second round trip and without keeping its own tally that a second tab
 * would invalidate (memory `project_multitab_concurrency`).
 */
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { ownedProduct } from '../../../lib/store-ownership.js';
import { setProductFeatured, STORE_PREVIEW_SLOTS } from '../../../lib/store-products.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  // Capped read — an unbounded body on an authenticated endpoint is the class
  // `lib/request-body.ts` exists for.
  const body = await readJsonBody<{ productId?: unknown; featured?: unknown }>(request, BODY_LIMIT.control);
  if (!body.ok) return json({ error: 'Bad request' }, body.status);

  const productId = typeof body.value?.productId === 'string' ? body.value.productId : '';
  // Strict boolean: a missing field must not read as "unfeature". This endpoint is a toggle the UI
  // drives, so the UI always knows which way it is going.
  if (typeof body.value?.featured !== 'boolean') return json({ error: 'Bad request' }, 400);
  const wanted = body.value.featured;

  // The ownership check runs BEFORE the write even though `setProductFeatured` also matches on
  // store_id — the two answer different questions. This one distinguishes 404 from 403, which the
  // dashboard's client already relies on; the WHERE clause is the backstop that makes a bug here
  // harmless rather than a cross-store write.
  const claim = await ownedProduct(sellerId, productId);
  if (!claim.ok) return json({ error: claim.reason === 'not-found' ? 'Not found' : 'Forbidden' }, claim.reason === 'not-found' ? 404 : 403);

  const result = await setProductFeatured(claim.store.id, productId, wanted);
  if (!result.ok) {
    return result.reason === 'limit'
      ? json({ error: 'limit', limit: STORE_PREVIEW_SLOTS, count: result.count }, 409)
      : json({ error: 'Not found' }, 404);
  }
  return json({ featured: result.featured, count: result.count, limit: STORE_PREVIEW_SLOTS });
};
