export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { ownedStore } from '../../lib/store-ownership.js';
import { getSpecRowsByStoreId } from '../../lib/store-products.js';
import { buildSpecVocabulary } from '../../lib/spec-vocabulary.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The attribute names and values a seller is offered while filling the product form's "מפרט" rows.
 *
 * **Its own request, rather than more bytes on the dashboard.** The products tab is already the
 * heaviest page here (memory `project_dashboard_html_weight`), and this payload is needed only once
 * a product editor is actually opened — which most visits to that tab never do. So it is fetched
 * lazily, once per page, and cached in the tab for the rest of the session.
 *
 * **A store id is not a permission** (memory `project_checkout_idempotency_ownership`): the session
 * proves who the seller is and `ownedStore` proves this store is theirs. Without that second check
 * this route hands any logged-in seller the attribute vocabulary — and therefore a readable slice of
 * the catalogue structure — of any store whose id they can guess.
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const storeId = url.searchParams.get('storeId') ?? '';
  const store = storeId ? await ownedStore(sellerId, storeId) : null;
  if (!store) return json({ ok: false, error: 'Not authorized' }, 403);

  const specRows = await getSpecRowsByStoreId(store.id);
  // The store's PLATFORM categories decide the starter set — see spec-vocabulary.ts for why it is
  // keyed off the curated vocabulary and not off the store's own free-text tree.
  const vocabulary = buildSpecVocabulary(specRows, store.categories ?? []);

  return json({ ok: true, ...vocabulary });
};
