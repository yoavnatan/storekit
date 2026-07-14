export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug, getStoreById, updateStore } from '../../../lib/stores.js';
import { getProductById, updateProduct } from '../../../lib/store-products.js';
import { createAdminMessage } from '../../../lib/admin-messages.js';
import { createNotification } from '../../../lib/notifications.js';

const json = { 'Content-Type': 'application/json' };

// The seller must always hear about a block and be able to contest it — a
// silent kill switch would violate the platform's own zero-touch promise in
// the other direction (the seller now has to *guess* something's wrong).
// Reuses the admin<->seller messaging thread built for CURRENT_TASK.md's
// "סשן א׳" (merged 2026-07-14): the notice lands as a system message the
// seller can reply to directly from their existing messages tab — that
// reply *is* the appeal channel, no separate UI needed.
function notifySellerOfModeration(sellerId: string, entityLabel: string, kind: 'store' | 'product', blocked: boolean): void {
  const content = blocked
    ? `ה${kind === 'store' ? 'חנות' : 'מוצר'} "${entityLabel}" נחסם/ה על ידי הצוות ואינו/ה זמין/ה יותר באתר. אם ברצונך לערער על ההחלטה או לקבל הסבר, פשוט השב/י להודעה זו.`
    : `ה${kind === 'store' ? 'חנות' : 'מוצר'} "${entityLabel}" שוחרר/ה מחסימה וחזר/ה להיות זמין/ה באתר.`;
  const message = createAdminMessage(sellerId, 'admin', content);
  createNotification({
    userId: sellerId,
    role: 'seller',
    type: 'admin_message',
    title: blocked ? 'חנות/מוצר נחסם' : 'חסימה בוטלה',
    body: content.slice(0, 120),
    relatedId: message.id,
  });
}

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
    const blocked = action === 'block-store';
    updateStore(store.id, { blocked });
    notifySellerOfModeration(store.sellerId, store.name, 'store', blocked);
    return new Response(JSON.stringify({ ok: true, blocked }), { headers: json });
  }

  if (action === 'block-product' || action === 'unblock-product') {
    const product = body?.productId ? getProductById(body.productId) : null;
    if (!product) return new Response(JSON.stringify({ error: 'Product not found' }), { status: 404, headers: json });
    const store = getStoreById(product.storeId);
    if (!store) return new Response(JSON.stringify({ error: 'Store not found' }), { status: 404, headers: json });
    const blocked = action === 'block-product';
    updateProduct(product.id, { blocked });
    notifySellerOfModeration(store.sellerId, product.name, 'product', blocked);
    return new Response(JSON.stringify({ ok: true, blocked }), { headers: json });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: json });
};
