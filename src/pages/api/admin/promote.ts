export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug, updateStore, MAX_PROMO_WEIGHT } from '../../../lib/stores.js';

const json = { 'Content-Type': 'application/json' };

// Silent "shop-window" promotion (CURRENT_TASK.md → סשן ב׳). Sets a store's
// admin-only curation weight — see stores.ts#promoWeight for what it affects
// and why it's moral: it only reorders placement in the platform's OWN
// discovery real estate (homepage + /stores), never fabricates social proof,
// costs the seller nothing.
//
// Deliberately does NOT notify the seller, the exact opposite of
// moderation.ts's block (which MUST tell the seller so they can appeal). A
// block is something done *to* a seller; a promotion is the platform spending
// its own discovery budget however it likes — there's nothing to disclose, and
// telling every seller "you may or may not be boosted for free" would only
// breed unfair expectations. Admin-guarded so no seller can reach it.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as { storeSlug?: string; weight?: unknown } | null;
  const store = body?.storeSlug ? getStoreBySlug(body.storeSlug) : null;
  if (!store) return new Response(JSON.stringify({ error: 'Store not found' }), { status: 404, headers: json });

  const raw = Number(body?.weight);
  const weight = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_PROMO_WEIGHT, Math.round(raw))) : 0;
  updateStore(store.id, { promoWeight: weight });
  return new Response(JSON.stringify({ ok: true, weight }), { headers: json });
};
