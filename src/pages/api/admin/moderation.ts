export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug, updateStore } from '../../../lib/stores.js';
import { getProductById, updateProduct } from '../../../lib/store-products.js';

const json = { 'Content-Type': 'application/json' };

// Admin-only kill switch for a store/product that's actively damaging the
// shared platform domain's Google standing (spam, policy violation, seller
// dispute, etc.) — see AI_INSTRUCTIONS.md → North star ("each store is
// sovereign" but they all share one domain's SEO reputation) and
// CURRENT_TASK.md → סשן ב׳. Never automatic; this is the one deliberately
// manual gate in an otherwise zero-touch platform, because it's a judgment
// call about a specific bad actor, not a routine operational flow.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as { action?: string; storeSlug?: string; productId?: string } | null;
  const action = body?.action ?? '';

  if (action === 'block-store' || action === 'unblock-store') {
    const store = body?.storeSlug ? getStoreBySlug(body.storeSlug) : null;
    if (!store) return new Response(JSON.stringify({ error: 'Store not found' }), { status: 404, headers: json });
    updateStore(store.id, { blocked: action === 'block-store' });
    return new Response(JSON.stringify({ ok: true, blocked: action === 'block-store' }), { headers: json });
  }

  if (action === 'block-product' || action === 'unblock-product') {
    const product = body?.productId ? getProductById(body.productId) : null;
    if (!product) return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404, headers: json });
    updateProduct(product.id, { blocked: action === 'block-product' });
    return new Response(JSON.stringify({ ok: true, blocked: action === 'block-product' }), { headers: json });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: json });
};
