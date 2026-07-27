export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../lib/stores.js';
import { createProduct, updateProduct, deleteProduct, getProductById, isSkuTaken, countStockAlerts, type StoreProduct } from '../../lib/store-products.js';
import { LOW_STOCK_THRESHOLD, generateCombos, comboKey, resolveVariantStockMap } from '../../lib/variant-combo.js';
import { parseImages, parseCategoryId, parseSku, parseTags, parseSpecs, parseSellerNote, parseVariantsPayload } from '../../lib/product-form.js';
import { getCategoryById, getCategoriesByStoreId, categoryPath } from '../../lib/store-categories.js';
import { deleteNotificationsByRelatedIds } from '../../lib/notifications.js';
import { findSpamKeyword, spamRejectionMessage, findKeywordStuffing, stuffingRejectionMessage } from '../../lib/spam-filter.js';
import { pingProductChange } from '../../lib/indexnow.js';
import { deriveAutoTags } from '../../lib/tag-suggest.js';

// Auto-tag a product from its structured, curated fields (category path +
// variant option values) at save time — the seller's explicit tags always come
// first and win on de-dupe; auto tags only ADD. Runs AFTER the spam/stuffing
// gate (which guards the seller's own text) since these sources are already
// validated structured data, so they can't trip a false stuffing rejection.
function withAutoTags(sellerTags: string[], categoryPathStr: string, variantValues: string[]): string[] {
  const auto = deriveAutoTags({ categoryPath: categoryPathStr, variantValues, existingTags: sellerTags });
  return [...sellerTags, ...auto];
}

function allVariantValues(variants: { options: string[] }[]): string[] {
  return variants.flatMap((v) => v.options);
}

// Values in `next` not already present in `prev` (case-insensitive) — the
// variant options genuinely NEW to an edit, so auto-tagging only fires for
// them. This is what lets a seller REMOVE an auto tag on edit and have it stay
// removed: a source that hasn't changed contributes no auto tag the second time.
function newVariantValues(prev: string[], next: string[]): string[] {
  const seen = new Set(prev.map((v) => v.trim().toLowerCase()));
  return next.filter((v) => !seen.has(v.trim().toLowerCase()));
}

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
    const ownerStore = stores.find((s) => s.id === storeId);
    if (!ownerStore) return json({ ok: false, error: 'Not authorized' }, 403);

    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    const price = parseFloat(String(form.get('price') || '0'));
    const stock = parseInt(String(form.get('stock') || '0'), 10);
    const images = parseImages(form);
    const categoryId = resolveCategoryId(parseCategoryId(form), storeId);
    const tags = parseTags(form);
    const sku = parseSku(form);
    const specs = parseSpecs(form);
    const sellerNote = parseSellerNote(form);
    const { variants, variantStock, variantImages } = parseVariantsPayload(form);

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
    if (sku && isSkuTaken(storeId, sku)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
    const spamHit = findSpamKeyword(name, description, ...tags);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name, description, ...tags);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    const catPathStr = categoryId ? categoryPath(getCategoriesByStoreId(storeId), categoryId) : '';
    const finalTags = withAutoTags(tags, catPathStr, allVariantValues(variants));

    const product = createProduct(storeId, {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
      images: images.length ? images : undefined,
      categoryId,
      tags: finalTags.length ? finalTags : undefined,
      sku: sku || undefined,
      specs: specs.length ? specs : undefined,
      sellerNote: sellerNote || undefined,
      variants: variants.length ? variants : undefined,
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
      variantImages: Object.keys(variantImages).length ? variantImages : undefined,
    });
    // A brand-new public page — the highest-value IndexNow signal (fire-and-forget).
    pingProductChange(ownerStore.slug, product.slug);
    return json({ ok: true, product, stockAlerts: countStockAlerts(storeId, LOW_STOCK_THRESHOLD) });
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
    const sellerNote = parseSellerNote(form);
    const { variants, variantStock, variantImages } = parseVariantsPayload(form);

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);
    if (sku && isSkuTaken(product.storeId, sku, productId)) return json({ ok: false, error: 'This SKU is already used by another product.' }, 400);
    const spamHit = findSpamKeyword(name, description, ...tags);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name, description, ...tags);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    // Per-combo SKUs are set only via CSV import; the editor doesn't render them, so preserve the
    // product's existing ones — but drop any whose combo no longer exists after an options edit
    // (a renamed/removed option changes the comboKey), so a stale code can't leak onto a new combo.
    const validComboKeys = new Set(generateCombos(variants).map(comboKey));
    const keptVariantSku = Object.fromEntries(
      Object.entries(product.variantSku ?? {}).filter(([key]) => validComboKeys.has(key)),
    );

    // On edit, auto-tag only from sources NEW since the last save — a category
    // that just changed, and variant options just added — so a seller who
    // removed an auto tag whose source is unchanged keeps it removed.
    const catChanged = (categoryId ?? '') !== (product.categoryId ?? '');
    const catPathStr = catChanged && categoryId ? categoryPath(getCategoriesByStoreId(product.storeId), categoryId) : '';
    const freshVariantValues = newVariantValues(allVariantValues(product.variants ?? []), allVariantValues(variants));
    const finalTags = withAutoTags(tags, catPathStr, freshVariantValues);

    const updates: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
      images,
      categoryId,
      tags: finalTags.length ? finalTags : [],
      sku: sku || undefined,
      specs: specs.length ? specs : [],
      sellerNote: sellerNote || undefined,
      variants: variants.length ? variants : [],
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
      variantSku: Object.keys(keptVariantSku).length ? keptVariantSku : undefined,
      variantImages: Object.keys(variantImages).length ? variantImages : undefined,
    };

    const updated = updateProduct(productId, updates);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // The seller just reviewed/re-entered this product's stock as part of the
    // full edit form — treat that as acknowledging any low-stock/out-of-stock
    // alert for it, same as an order's status change clearing its own notification.
    deleteNotificationsByRelatedIds([productId], sellerId);
    const categoryPathStr = updated.categoryId ? categoryPath(getCategoriesByStoreId(product.storeId), updated.categoryId) : '';
    return json({ ok: true, images: updated.images ?? [], categoryId: updated.categoryId ?? '', categoryPath: categoryPathStr, stockAlerts: countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
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
    return json({ ok: true, product: { name: updated.name, price: updated.price, stock: updated.stock, sku: updated.sku ?? '' }, stockAlerts: countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  // Inline edit of a single variant combo's stock from the products-table
  // breakdown dropdown — the per-combo mirror of `patch-product-fields`' whole
  // `stock` edit. Persists the FULL per-combo map (via resolveVariantStockMap)
  // so a product still on the shared pool is converted to explicit per-combo
  // stock exactly as displayed, and the total `stock` becomes their sum.
  if (action === 'patch-variant-stock') {
    const productId = String(form.get('productId') || '');
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const stores = getStoresBySellerId(sellerId);
    if (!stores.find((s) => s.id === product.storeId)) return json({ ok: false, error: 'Not authorized.' }, 403);
    if (!product.variants?.length) return json({ ok: false, error: 'Product has no variants.' }, 400);

    const key = String(form.get('comboKey') || '');
    const validKeys = new Set(generateCombos(product.variants).map(comboKey));
    if (!validKeys.has(key)) return json({ ok: false, error: 'Unknown variant combination.' }, 400);
    const value = parseInt(String(form.get('stock')), 10);
    const clamped = isNaN(value) ? 0 : Math.max(0, value);

    const map = resolveVariantStockMap(product.variants, product.variantStock, product.stock);
    map[key] = clamped;
    const total = Object.values(map).reduce((s, n) => s + n, 0);

    const updated = updateProduct(productId, { variantStock: map, stock: total });
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    deleteNotificationsByRelatedIds([productId], sellerId);
    return json({ ok: true, comboKey: key, comboStock: clamped, stock: total, stockAlerts: countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
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

  if (action === 'set-product-visibility') {
    const productId = String(form.get('productId') || '');
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const stores = getStoresBySellerId(sellerId);
    const visStore = stores.find((s) => s.id === product.storeId);
    if (!visStore) return json({ ok: false, error: 'Not authorized.' }, 403);
    // A seller can only flip their own take-down flag; an admin `blocked` product
    // stays hidden regardless (isProductVisible gates on both).
    const hidden = String(form.get('hidden') || '') === '1';
    const updated = updateProduct(productId, { hidden });
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    // Indexability just changed (show → wants indexing / hide → drop) — notify.
    pingProductChange(visStore.slug, updated.slug);
    // Taking a product off the shelf resolves any outstanding stock alert for it —
    // the seller has consciously decided it's not for sale, so nagging about its
    // stock would be exactly the noise this feature removes.
    if (hidden) deleteNotificationsByRelatedIds([productId], sellerId);
    return json({ ok: true, hidden: updated.hidden === true, stockAlerts: countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  if (action === 'delete-product') {
    const productId = String(form.get('productId') || '');
    const product = getProductById(productId);
    if (!product) return json({ ok: false, error: 'Product not found.' }, 404);
    const stores = getStoresBySellerId(sellerId);
    if (!stores.find((s) => s.id === product.storeId)) return json({ ok: false, error: 'Not authorized.' }, 403);
    deleteProduct(productId);
    return json({ ok: true, stockAlerts: countStockAlerts(product.storeId, LOW_STOCK_THRESHOLD) });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
