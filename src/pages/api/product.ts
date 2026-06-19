export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../lib/stores.js';
import { createProduct, updateProduct, deleteProduct, getProductById, type StoreProduct } from '../../lib/store-products.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const form = await request.formData();
  const action = String(form.get('_action') || '');

  if (action === 'add-product') {
    const storeId = String(form.get('storeId') || '');
    const stores = getStoresBySellerId(sellerId);
    if (!stores.find((s) => s.id === storeId)) return json({ ok: false, error: 'Not authorized' }, 403);

    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    const price = parseFloat(String(form.get('price') || '0'));
    const stock = parseInt(String(form.get('stock') || '0'), 10);
    const image = String(form.get('image') || '').trim() || undefined;

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);

    const product = createProduct(storeId, { name, description, price, stock: isNaN(stock) ? 0 : stock, image });
    return json({ ok: true, product });
  }

  if (action === 'edit-product') {
    const productId = String(form.get('productId') || '');
    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    const price = parseFloat(String(form.get('price') || '0'));
    const stock = parseInt(String(form.get('stock') || '0'), 10);
    const imageVal = String(form.get('image') || '').trim();

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);

    const updates: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
    };
    if (imageVal) updates.image = imageVal;

    const updated = updateProduct(productId, updates);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    return json({ ok: true, image: updated.image ?? null });
  }

  if (action === 'delete-product') {
    const productId = String(form.get('productId') || '');
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const stores = getStoresBySellerId(sellerId);
    if (!stores.find((s) => s.id === product.storeId)) return json({ ok: false, error: 'Not authorized.' }, 403);
    deleteProduct(productId);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
