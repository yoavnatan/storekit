export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import {
  getCampaignsByStoreId, createCampaign, updateCampaign, deleteCampaign,
  getMockCampaignStats, getMockBaselineImpressions,
} from '../../../lib/ad-campaigns.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function withStats(campaign: ReturnType<typeof getCampaignsByStoreId>[number]) {
  return { ...campaign, stats: getMockCampaignStats(campaign) };
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  const stores = getStoresBySellerId(sellerId);
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const campaigns = getCampaignsByStoreId(store.id).map(withStats);
  return json({ ok: true, campaigns, baselineImpressions: getMockBaselineImpressions(store.id) });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  let body: { storeSlug?: unknown; scope?: unknown; productId?: unknown; platform?: unknown; monthlyBudget?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { storeSlug, scope, productId, platform, monthlyBudget } = body;
  if (typeof storeSlug !== 'string') return json({ error: 'Missing storeSlug' }, 400);
  if (scope !== 'store' && scope !== 'product') return json({ error: 'Invalid scope' }, 400);
  if (platform !== 'google' && platform !== 'meta') return json({ error: 'Invalid platform' }, 400);
  if (typeof monthlyBudget !== 'number' || !isFinite(monthlyBudget) || monthlyBudget < 50) {
    return json({ error: 'Minimum monthly budget is 50 ₪' }, 400);
  }

  const stores = getStoresBySellerId(sellerId);
  const store = stores.find((s) => s.slug === storeSlug);
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
    ...(resolvedProductId ? { productId: resolvedProductId, productName } : {}),
  });
  return json({ ok: true, campaign: withStats(campaign) });
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
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const updates: Partial<{ monthlyBudget: number; status: 'active' | 'paused' }> = {};
  if (typeof monthlyBudget === 'number' && isFinite(monthlyBudget) && monthlyBudget >= 50) updates.monthlyBudget = Math.round(monthlyBudget * 100) / 100;
  if (status === 'active' || status === 'paused') updates.status = status;
  if (Object.keys(updates).length === 0) return json({ error: 'No valid fields to update' }, 400);

  const updated = updateCampaign(id, store.id, updates);
  if (!updated) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true, campaign: withStats(updated) });
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
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const ok = deleteCampaign(id, store.id);
  if (!ok) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true });
}
