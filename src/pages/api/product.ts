export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../lib/stores.js';
import { createProduct, updateProduct, deleteProduct, getProductById, isSkuTaken, type StoreProduct } from '../../lib/store-products.js';
import { parseImages, parseCategoryId, parseSku, parseTags, parseSpecs, parseVariantsPayload } from '../../lib/product-form.js';
import { getCategoryById, getCategoriesByStoreId, categoryPath } from '../../lib/store-categories.js';
import { deleteNotificationsByRelatedIds } from '../../lib/notifications.js';
import { findSpamKeyword, spamRejectionMessage, findKeywordStuffing, stuffingRejectionMessage } from '../../lib/spam-filter.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Never trust a client-supplied categoryId at face value — confirm it's a real
// node belonging to this exact store before it's allowed onto the product.
function resolveCategoryId(raw: string, storeId: string): string | undefined {
  if (!raw) return undefined;
  const category = getCategoryById(raw);
  return category && category.storeId === storeId ? category.id : undefined;
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
    const images = parseImages(form);
    const categoryId = resolveCategoryId(parseCategoryId(form), storeId);
    const tags = parseTags(form);
    const sku = parseSku(form);
    const specs = parseSpecs(form);
    const { variants, variantStock, variantImages } = parseVariantsPayload(form);

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
    if (sku && isSkuTaken(storeId, sku)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
    const spamHit = findSpamKeyword(name, description, ...tags);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name, description, ...tags);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    const product = createProduct(storeId, {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
      images: images.length ? images : undefined,
      categoryId,
      tags: tags.length ? tags : undefined,
      sku: sku || undefined,
      specs: specs.length ? specs : undefined,
      variants: variants.length ? variants : undefined,
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
      variantImages: Object.keys(variantImages).length ? variantImages : undefined,
    });
    return json({ ok: true, product });
  }

  if (action === 'edit-product') {
    const productId = String(form.get('productId') || '');
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const ownedStores = getStoresBySellerId(sellerId);
    if (!ownedStores.find((s) => s.id === product.storeId)) return json({ ok: false, error: 'Not authorized.' }, 403);

    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    const price = parseFloat(String(form.get('price') || '0'));
    const stock = parseInt(String(form.get('stock') || '0'), 10);
    const images = parseImages(form);
    const categoryId = resolveCategoryId(parseCategoryId(form), product.storeId);
    const tags = parseTags(form);
    const sku = parseSku(form);
    const specs = parseSpecs(form);
    const { variants, variantStock, variantImages } = parseVariantsPayload(form);

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
    if (sku && isSkuTaken(product.storeId, sku, productId)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
    const spamHit = findSpamKeyword(name, description, ...tags);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name, description, ...tags);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    const updates: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
      images,
      categoryId,
      tags: tags.length ? tags : [],
      sku: sku || undefined,
      specs: specs.length ? specs : [],
      variants: variants.length ? variants : [],
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
      variantImages: Object.keys(variantImages).length ? variantImages : undefined,
    };

    const updated = updateProduct(productId, updates);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // The seller just reviewed/re-entered this product's stock as part of the
    // full edit form — treat that as acknowledging any low-stock/out-of-stock
    // alert for it, same as an order's status change clearing its own notification.
    deleteNotificationsByRelatedIds([productId], sellerId);
    const categoryPathStr = updated.categoryId ? categoryPath(getCategoriesByStoreId(product.storeId), updated.categoryId) : '';
    return json({ ok: true, images: updated.images ?? [], categoryId: updated.categoryId ?? '', categoryPath: categoryPathStr });
  }

  if (action === 'patch-product-fields') {
    const productId = String(form.get('productId') || '');
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const stores = getStoresBySellerId(sellerId);
    if (!stores.find((s) => s.id === product.storeId)) return json({ ok: false, error: 'Not authorized.' }, 403);

    const patch: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {};
    if (form.has('name')) {
      const name = String(form.get('name') || '').trim();
      if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
      const spamHit = findSpamKeyword(name);
      if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
      const stuffingHit = findKeywordStuffing(name);
      if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);
      patch.name = name;
    }
    if (form.has('price')) {
      const price = parseFloat(String(form.get('price')));
      if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
      patch.price = price;
    }
    if (form.has('stock')) {
      const stock = parseInt(String(form.get('stock')), 10);
      patch.stock = isNaN(stock) ? 0 : Math.max(0, stock);
    }
    if (form.has('sku')) {
      const sku = parseSku(form);
      if (sku && isSkuTaken(product.storeId, sku, productId)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
      patch.sku = sku || undefined;
    }

    const updated = updateProduct(productId, patch);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // Only clear when the stock cell itself was the one edited — a name/price/sku
    // inline edit shouldn't silently dismiss an unrelated low-stock alert.
    if ('stock' in patch) deleteNotificationsByRelatedIds([productId], sellerId);
    return json({ ok: true, product: { name: updated.name, price: updated.price, stock: updated.stock, sku: updated.sku ?? '' } });
  }

  if (action === 'patch-product-images') {
    const productId = String(form.get('productId') || '');
    const images = parseImages(form);
    if (!productId) return json({ ok: false, error: 'Missing productId.' }, 400);
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const stores = getStoresBySellerId(sellerId);
    if (!stores.find((s) => s.id === product.storeId)) return json({ ok: false, error: 'Not authorized.' }, 403);
    const updated = updateProduct(productId, { images });
    return json({ ok: true, images: updated?.images ?? [] });
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
