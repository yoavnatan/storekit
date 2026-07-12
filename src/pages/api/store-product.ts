export const prerender = false;
import type { APIRoute } from 'astro';
import { getStoreBySlug } from '../../lib/stores.js';
import { getProductBySlug } from '../../lib/store-products.js';

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
  if (!store) return json({ error: 'Store not found' }, 404);

  const product = getProductBySlug(store.id, productSlug);
  if (!product) return json({ error: 'Product not found' }, 404);

  return json({
    slug:        product.slug,
    name:        product.name,
    price:       product.price,
    description: product.description ?? '',
    stock:       product.stock,
    images:      product.images ?? [],
    category:    product.category ?? '',
    tags:        product.tags ?? [],
    specs:       product.specs ?? [],
    variants:    product.variants ?? [],
    variantImages: product.variantImages ?? {},
  });
};
