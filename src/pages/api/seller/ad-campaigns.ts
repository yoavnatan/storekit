export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { findStoreBySlugOrPrevious, getStoresBySellerId } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import {
  getCampaignsByStoreId, createCampaign, updateCampaign, deleteCampaign,
  parseDuration, parseAudience,
} from '../../../lib/ad-campaigns.js';
import { withCampaignStats } from '../../../lib/ad-metrics.js';
import { resolveAdRange } from '../../../lib/date-range.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // A dated preset (or custom from/to) windows the metrics ("recent activity");
  // lifetime / no preset → per-campaign lifetime totals (the default). The
  // baseline exposure card is a separate stable lifetime figure rendered SSR,
  // so it isn't part of this response.
  const range = resolveAdRange(url.searchParams);
  const campaigns = getCampaignsByStoreId(store.id).map((c) => withCampaignStats(c, range));
  return json({ ok: true, campaigns });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

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

  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, storeSlug);
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
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  let body: { id?: unknown; storeSlug?: unknown; monthlyBudget?: unknown; status?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id, storeSlug, monthlyBudget, status } = body;
  if (typeof id !== 'string' || typeof storeSlug !== 'string') return json({ error: 'Missing id or storeSlug' }, 400);

  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, storeSlug);
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
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  let body: { id?: unknown; storeSlug?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { id, storeSlug } = body;
  if (typeof id !== 'string' || typeof storeSlug !== 'string') return json({ error: 'Missing id or storeSlug' }, 400);

  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const ok = deleteCampaign(id, store.id);
  if (!ok) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true });
}
