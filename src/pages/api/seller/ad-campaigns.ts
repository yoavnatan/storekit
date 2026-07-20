export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import {
  getCampaignsByStoreId, createCampaign, updateCampaign, deleteCampaign,
  getMockCampaignStats, getMockBaselineImpressions, parseDuration, parseAudience,
} from '../../../lib/ad-campaigns.js';
import { campaignStatsInRange, baselineImpressionsInRange } from '../../../lib/ad-metrics.js';
import { presetRange, coerceRange, type AdRangePreset, AD_RANGE_PRESETS } from '../../../lib/date-range.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function withStats(campaign: ReturnType<typeof getCampaignsByStoreId>[number], range?: { from: string; to: string }) {
  // range === undefined → the admin per-store view (no date filter): keep the
  // original lifetime mock. A range → the seller's date-windowed view.
  return { ...campaign, stats: range ? campaignStatsInRange(campaign, range.from, range.to) : getMockCampaignStats(campaign) };
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  const stores = getStoresBySellerId(sellerId);
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Date range: an explicit preset (or custom from/to) → window the metrics;
  // no range param at all → lifetime totals (the admin per-store control view).
  const presetRaw = url.searchParams.get('preset') as AdRangePreset | null;
  const hasRange = presetRaw !== null || url.searchParams.has('from');
  let range: { from: string; to: string } | undefined;
  if (hasRange) {
    const preset: AdRangePreset = AD_RANGE_PRESETS.includes(presetRaw as AdRangePreset) ? presetRaw! : '7d';
    range = preset === 'custom' ? coerceRange(url.searchParams.get('from'), url.searchParams.get('to')) : presetRange(preset)!;
  }

  const campaigns = getCampaignsByStoreId(store.id).map((c) => withStats(c, range));
  const baselineImpressions = range ? baselineImpressionsInRange(store.id, range.from, range.to) : getMockBaselineImpressions(store.id);
  return json({ ok: true, campaigns, baselineImpressions, range: range ?? null });
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
    ...(durationDays ? { durationDays } : {}),
    ...(audience ? { audience } : {}),
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
