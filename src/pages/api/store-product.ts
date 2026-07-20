export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlug, isStoreVisible } from '../../lib/stores.js';
import { getProductBySlug, isProductVisible } from '../../lib/store-products.js';
import { getCategoriesByStoreId, categoryPath } from '../../lib/store-categories.js';
import { recordProductView } from '../../lib/product-pageviews.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = ({ url }) => {
  const storeSlug   = url.searchParams.get('store') ?? '';
  const productSlug = url.searchParams.get('product') ?? '';

  if (!storeSlug || !productSlug) return json({ error: 'Missing params' }, 400);

  const store = getStoreBySlug(storeSlug);
  if (!store || !isStoreVisible(store)) return json({ error: 'Store not found' }, 404);

  const product = getProductBySlug(store.id, productSlug);
  if (!product || !isProductVisible(product)) return json({ error: 'Product not found' }, 404);

  // This endpoint is the shared quick-view/product modal's data source, so a GET
  // here is a genuine product view without a full page navigation — count it
  // toward the product's total views (same counter the product page taps in
  // middleware), so the per-product metric reflects modal opens too, not only
  // page loads (CURRENT_TASK.md, סשן א׳). Fire-and-forget; never blocks the read.
  recordProductView(product.id);

  return json({
    slug:        product.slug,
    name:        product.name,
    price:       product.price,
    description: product.description ?? '',
    stock:       product.stock,
    images:      product.images ?? [],
    categoryId:  product.categoryId ?? '',
    category:    product.categoryId ? categoryPath(getCategoriesByStoreId(store.id), product.categoryId) : '',
    tags:        product.tags ?? [],
    specs:       product.specs ?? [],
    variants:    product.variants ?? [],
    variantStock: product.variantStock ?? {},
    variantImages: product.variantImages ?? {},
  });
};
