export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../lib/stores.js';
import { createProduct, updateProduct, deleteProduct, getProductById, type StoreProduct, type ProductVariant } from '../../lib/store-products.js';
import { comboKey, generateCombos } from '../../lib/variant-combo.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseImages(form: FormData): string[] {
  return form.getAll('images').map(v => String(v).trim()).filter(Boolean);
}

function parseCategory(form: FormData): string {
  return String(form.get('category') ?? '').trim();
}

function parseTags(form: FormData): string[] {
  return String(form.get('tags') ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

function parseSpecs(form: FormData): Array<{ label: string; value: string }> {
  const labels = form.getAll('specs_label').map(v => String(v).trim());
  const values = form.getAll('specs_value').map(v => String(v).trim());
  return labels.map((label, i) => ({ label, value: values[i] ?? '' })).filter(s => s.label);
}

interface VariantsPayload {
  variants: ProductVariant[];
  variantStock: Record<string, number>;
}

/** Parses the single `variants_json` field the dashboard serializes before submit — replaces
 *  the old parallel `variant_name`/`variant_options` array zipping, which silently misaligned
 *  if a block was ever added/removed out of order. */
function parseVariantsPayload(form: FormData): VariantsPayload {
  const empty: VariantsPayload = { variants: [], variantStock: {} };
  const raw = String(form.get('variants_json') || '');
  if (!raw) return empty;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  if (!parsed || typeof parsed !== 'object') return empty;
  const obj = parsed as { variants?: unknown; variantStock?: unknown };

  const variants: ProductVariant[] = Array.isArray(obj.variants)
    ? obj.variants
        .map((v): ProductVariant | null => {
          if (!v || typeof v !== 'object') return null;
          const name = String((v as { name?: unknown }).name ?? '').trim();
          const rawOptions = (v as { options?: unknown }).options;
          const options = Array.isArray(rawOptions)
            ? rawOptions.map((o) => String(o).trim()).filter(Boolean)
            : [];
          return name && options.length ? { name, options } : null;
        })
        .filter((v): v is ProductVariant => v !== null)
    : [];

  // Only keep stock entries for combos that actually exist for the final variant set —
  // guards against stale/tampered keys once options are renamed or removed client-side.
  const validKeys = new Set(generateCombos(variants).map(comboKey));
  const variantStock: Record<string, number> = {};
  if (obj.variantStock && typeof obj.variantStock === 'object') {
    for (const [key, val] of Object.entries(obj.variantStock as Record<string, unknown>)) {
      if (!validKeys.has(key)) continue;
      const n = Math.floor(Number(val));
      if (Number.isFinite(n) && n >= 0) variantStock[key] = n;
    }
  }

  return { variants, variantStock };
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
    const category = parseCategory(form);
    const tags = parseTags(form);
    const specs = parseSpecs(form);
    const { variants, variantStock } = parseVariantsPayload(form);

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);

    const product = createProduct(storeId, {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
      images: images.length ? images : undefined,
      category: category || undefined,
      tags: tags.length ? tags : undefined,
      specs: specs.length ? specs : undefined,
      variants: variants.length ? variants : undefined,
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
    });
    return json({ ok: true, product });
  }

  if (action === 'edit-product') {
    const productId = String(form.get('productId') || '');
    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    const price = parseFloat(String(form.get('price') || '0'));
    const stock = parseInt(String(form.get('stock') || '0'), 10);
    const images = parseImages(form);
    const category = parseCategory(form);
    const tags = parseTags(form);
    const specs = parseSpecs(form);
    const { variants, variantStock } = parseVariantsPayload(form);

    if (!name) return json({ ok: false, error: 'Product name is required.' }, 400);
    if (isNaN(price) || price < 0) return json({ ok: false, error: 'Enter a valid price.' }, 400);

    const updates: Partial<Omit<StoreProduct, 'id' | 'storeId' | 'createdAt'>> = {
      name, description, price, stock: isNaN(stock) ? 0 : stock,
      images,
      category: category || undefined,
      tags: tags.length ? tags : [],
      specs: specs.length ? specs : [],
      variants: variants.length ? variants : [],
      variantStock: Object.keys(variantStock).length ? variantStock : undefined,
    };

    const updated = updateProduct(productId, updates);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    return json({ ok: true, images: updated.images ?? [] });
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

    const updated = updateProduct(productId, patch);
    if (!updated) return json({ ok: false, error: 'Product not found.' }, 404);
    return json({ ok: true, product: { name: updated.name, price: updated.price, stock: updated.stock } });
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
