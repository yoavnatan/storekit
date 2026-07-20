export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import {
  getCampaignsByStoreId, createCampaign, updateCampaign, deleteCampaign,
  parseDuration, parseAudience,
} from '../../../lib/ad-campaigns.js';
import { withCampaignStats } from '../../../lib/ad-metrics.js';
import { resolveAdRange } from '../../../lib/date-range.js';

// Admin-facing twin of /api/seller/ad-campaigns: identical validation and
// campaign shape, but gated by the admin cookie (requireAdmin) and able to
// manage ANY store's boost campaigns by slug — the seller route is scoped to
// the caller's own session-owned stores, the admin owns none, so the slug is
// the only key here (mirrors /api/admin/performance). Lets the platform owner
// launch/pause/retune a store's advertising directly (CURRENT_TASK.md item 2).
// Still mock data — no real Google/Meta charge happens (see ad-campaigns.ts),
// so this doesn't fall under the money-moves-need-a-mutex/Vitest rule.

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const store = getStoreBySlug(url.searchParams.get('storeSlug') ?? '');
  if (!store) return json({ error: 'Store not found' }, 404);

  // Same window/lifetime semantics as the seller route (shared resolveAdRange) so
  // the one picker (advertising.ts) drives both. lifetime/no-preset → lifetime.
  const range = resolveAdRange(url.searchParams);
  const campaigns = getCampaignsByStoreId(store.id).map((c) => withCampaignStats(c, range));
  return json({ ok: true, campaigns });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  let body: { storeSlug?: unknown; scope?: unknown; productId?: unknown; platform?: unknown; monthlyBudget?: unknown; durationDays?: unknown; audience?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { storeSlug, scope, productId, platform, monthlyBudget } = body;
  const durationDays = parseDuration(body.durationDays);
  // A store-wide campaign self-targets per product (each product's own feed
  // attributes) — it never carries a single audience, even if one is posted.
  const audience = scope === 'product' ? parseAudience(body.audience) : undefined;
  if (typeof storeSlug !== 'string') return json({ error: 'Missing storeSlug' }, 400);
  if (scope !== 'store' && scope !== 'product') return json({ error: 'Invalid scope' }, 400);
  if (platform !== 'google' && platform !== 'meta' && platform !== 'both') return json({ error: 'Invalid platform' }, 400);
  if (typeof monthlyBudget !== 'number' || !isFinite(monthlyBudget) || monthlyBudget < 50) {
    return json({ error: 'Minimum monthly budget is 50 ₪' }, 400);
  }

  const store = getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  let productName: string | undefined;
  let resolvedProductId: string | undefined;
  if (scope === 'product') {
    if (typeof productId !== 'string') return json({ error: 'Missing productId' }, 400);
    const product = getProductsByStoreId(store.id).find((p) => p.id === productId);
    if (!product) return json({ error: 'Product not found' }, 404);
    resolvedProductId = product.id;
    productName = product.name;
  }

  const campaign = createCampaign({
    storeId: store.id,
    storeSlug: store.slug,
    scope,
    platform,
    monthlyBudget: Math.round(monthlyBudget * 100) / 100,
    ...(durationDays ? { durationDays } : {}),
    ...(audience ? { audience } : {}),
    ...(resolvedProductId ? { productId: resolvedProductId, productName } : {}),
  });
  return json({ ok: true, campaign: withCampaignStats(campaign) });
}

export async function PATCH({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  let body: { id?: unknown; storeSlug?: unknown; monthlyBudget?: unknown; status?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id, storeSlug, monthlyBudget, status } = body;
  if (typeof id !== 'string' || typeof storeSlug !== 'string') return json({ error: 'Missing id or storeSlug' }, 400);

  const store = getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const updates: Partial<{ monthlyBudget: number; status: 'active' | 'paused' }> = {};
  if (typeof monthlyBudget === 'number' && isFinite(monthlyBudget) && monthlyBudget >= 50) updates.monthlyBudget = Math.round(monthlyBudget * 100) / 100;
  if (status === 'active' || status === 'paused') updates.status = status;
  if (Object.keys(updates).length === 0) return json({ error: 'No valid fields to update' }, 400);

  const updated = updateCampaign(id, store.id, updates);
  if (!updated) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true, campaign: withCampaignStats(updated) });
}

export async function DELETE({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  let body: { id?: unknown; storeSlug?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id, storeSlug } = body;
  if (typeof id !== 'string' || typeof storeSlug !== 'string') return json({ error: 'Missing id or storeSlug' }, 400);

  const store = getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const ok = deleteCampaign(id, store.id);
  if (!ok) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true });
}
