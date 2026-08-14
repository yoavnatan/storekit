export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlugOrPrevious, isStoreVisible } from '../../lib/stores.js';
import { getVisibleProductsByStoreId } from '../../lib/store-products.js';
import { resolvePrice } from '../../lib/discounts.js';
import { normalizeHe } from '../../lib/product-listing.js';
import { searchableVariantValues } from '../../lib/product-search-text.js';

/**
 * The store header search's product index — every visible product in ONE store,
 * reduced to the five fields the dropdown actually paints.
 *
 * **Why this endpoint exists.** The store and product pages used to serialise this
 * exact list into `<script id="header-search-products">` inside the HTML, so typing
 * in the header search matched locally with no network hop. That is a genuinely good
 * interaction and it is preserved — but it was being paid for by every visitor on
 * every page load, whether or not they ever touched the search box, in the one place
 * page weight turns into LCP and LCP turns into ranking. Measured 2026-08-03 on the
 * biggest showcase store: 24.1KB of the store page's HTML, and it scales with the
 * catalog — the target segment is stores with dozens to hundreds of products.
 *
 * **What did NOT change: the search is still local and still instant.** This is not
 * "search moved to the server" — `/api/store-products?q=` already exists and would
 * have made every keystroke wait on a round trip, which is a behaviour change the
 * shopper feels. The index is simply fetched out of band: the header warms it during
 * idle time after the page has painted, and again on first focus, so it is in memory
 * before a first character is typed. The matching itself never leaves the browser.
 *
 * **If it fails, search still works.** The dropdown degrades to no suggestions and
 * Enter still submits the query, which is the same path a no-JS visitor takes.
 *
 * Sale prices are resolved HERE with the same `discounts.ts` the page used, rather
 * than shipping a second price shape for the client to re-derive — the dropdown must
 * show what the product page will charge.
 */

type SearchProduct = {
  slug: string;
  name: string;
  price: number;
  /** Only when discounted — the dropdown renders it struck through. */
  basePrice?: number;
  /** The RAW image URL. The client wraps it in `cdnThumb` for its 56px cell, so
   *  sending a pre-sized URL here would both be longer and defeat that crop. */
  image: string;
  /** Everything BESIDES the name that this product can be found by — its tags and its searchable
   *  variant values (product-search-text.ts) — already normalised, and omitted when there is
   *  nothing. Sent because the dropdown's silence is a claim: server-side search matches a
   *  product on its colours (migration 0027), so a name-only dropdown would answer "לא נמצאו
   *  מוצרים" for "צהוב" and then Enter would find three. Normalised HERE and the name left raw so
   *  the payload carries each string once — the client normalises the name it already has and
   *  joins the two, which is character-for-character what normalising the whole haystack gives. */
  find?: string;
};

function json(data: unknown, status = 200, cache?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(cache ? { 'Cache-Control': cache } : {}),
    },
  });
}

export const GET: APIRoute = async ({ url }) => {
  const storeSlug = url.searchParams.get('store') ?? '';
  const store = storeSlug ? await getStoreBySlugOrPrevious(storeSlug) : null;
  if (!store || !isStoreVisible(store)) return json({ ok: false, error: 'Store not found.' }, 404);

  const visible = await getVisibleProductsByStoreId(store.id);
  const products: SearchProduct[] = visible.map((p) => {
    const view = resolvePrice(p, store.sale);
    const find = normalizeHe([...(p.tags ?? []), ...searchableVariantValues(p.variants)].join(' '));
    return {
      slug: p.slug,
      name: p.name,
      price: view.price,
      basePrice: view.isDiscounted ? p.price : undefined,
      image: p.images?.[0] ?? '',
      ...(find ? { find } : {}),
    };
  });

  // Short and public: this is the store's own catalog, identical for every visitor,
  // and it is a search AID — the product page is what's authoritative about a price.
  // A minute of staleness in a suggestion row costs nothing; re-fetching it on every
  // page of a browsing session costs a round trip each time.
  return json({ ok: true, products }, 200, 'public, max-age=60');
};
