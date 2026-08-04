export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlugOrPrevious, isStoreVisible, canStoreSell } from '../../lib/stores.js';
import { getProductBySlug, isProductVisible } from '../../lib/store-products.js';
import { getCategoriesByStoreId, categoryPath } from '../../lib/store-categories.js';
import { recordPageViewTap } from '../../lib/page-view-tap.js';
import { isBotRequest } from '../../lib/bot-detect.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import { resolvePrice } from '../../lib/discounts.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async ({ url, cookies, request }) => {
  const storeSlug   = url.searchParams.get('store') ?? '';
  const productSlug = url.searchParams.get('product') ?? '';

  if (!storeSlug || !productSlug) return json({ error: 'Missing params' }, 400);

  const store = await getStoreBySlugOrPrevious(storeSlug);
  if (!store || !isStoreVisible(store)) return json({ error: 'Store not found' }, 404);

  const product = await getProductBySlug(store.id, productSlug);
  if (!product || !isProductVisible(product)) return json({ error: 'Product not found' }, 404);

  // This endpoint is the shared quick-view/product modal's data source, so a GET
  // here is a genuine product view without a full page navigation — count it
  // toward the product's total views (same counter the product page taps in
  // middleware), so the per-product metric reflects modal opens too, not only
  // page loads (CURRENT_TASK.md, סשן א׳). Fire-and-forget; never blocks the read.
  // Bots and the store's own owner are excluded here too: middleware's filters
  // only cover page navigations, and this endpoint is a second, independent way
  // into the same counter — a seller opening the quick-view on their own product
  // (from their storefront, or the dashboard's kebab "preview") would otherwise
  // still inflate the view count they judge that product by.
  const isOwner = getSellerSession(cookies) === store.sellerId;
  if (!isBotRequest(request) && !isOwner) {
    // The product counter AND the funnel view_item, in one statement — a quick-view open advances
    // the buyer funnel exactly as a full page load does, and it is the same single round trip
    // middleware makes (`page-view-tap.ts`). No `page_view` here: this is an API call inside a page
    // the funnel has already counted. No sn_vid yet (pre-first-page API hit) → recorded without a
    // session id, still counting toward raw view volume.
    void recordPageViewTap({
      events: ['view_item'],
      visitorId: cookies.get('sn_vid')?.value,
      productId: product.id,
      productEvent: 'view_item',
      productIds: [product.id],
    });
  }

  // `price` stays the field every existing client reads, and it now carries the price the
  // buyer would actually be CHARGED (checkout derives it the same way) — a stale client that
  // ignores the added fields therefore still shows a real number, never a lapsed one.
  const priceView = resolvePrice(product, store.sale);

  return json({
    // The quick-view's add-to-cart reports to Google and Meta, and they key on the catalog id —
    // which is this uuid, never the slug (lib/ad-item-id.ts). Additive; an older client ignoring
    // it behaves exactly as before.
    id:          product.id,
    slug:        product.slug,
    name:        product.name,
    price:       priceView.price,
    basePrice:   priceView.basePrice,
    isDiscounted: priceView.isDiscounted,
    percentOff:  priceView.percentOff,
    showSaleBadge: priceView.showBadge,
    description: product.description ?? '',
    stock:       product.stock,
    images:      product.images ?? [],
    categoryId:  product.categoryId ?? '',
    category:    product.categoryId ? categoryPath(await getCategoriesByStoreId(store.id), product.categoryId) : '',
    tags:        product.tags ?? [],
    specs:       product.specs ?? [],
    variants:    product.variants ?? [],
    variantStock: product.variantStock ?? {},
    variantImages: product.variantImages ?? {},
    // Additive flag (never removed, never repurposed — Hard rules → backward-compatible API):
    // the store is reachable but not selling right now (store-status.ts). The quick-view shows
    // a notice in place of the buy control instead of reporting stock 0, which would be a
    // different and untrue reason. An older client that ignores it still can't complete a
    // purchase — /api/checkout is the gate that actually refuses.
    storeHalted: !canStoreSell(store),
  });
};
