export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { findStoreBySlugOrPrevious, getStoresBySellerId } from '../../../lib/stores.js';
import { createCampaign, updateCampaign, archiveCampaign } from '../../../lib/ad-campaigns.js';
import { getCampaignsForStore, getCampaignHistory, resumeBlockReason } from '../../../lib/ad-campaign-health.js';
import { buildCampaignInput, isValidCampaignBudget } from '../../../lib/ad-campaign-input.js';
import { withCampaignStats } from '../../../lib/ad-metrics.js';
import { resolveAdRange } from '../../../lib/date-range.js';
import { roundMoney } from '../../../lib/money.js';

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
  // getCampaignsForStore (not the raw accessor): it attaches each campaign's health and pauses
  // any that has nothing left on the storefront to advertise (ad-campaign-health.ts).
  const campaigns = getCampaignsForStore(store.id).map((c) => withCampaignStats(c, range));
  // History rides along in the same response: the two lists are rendered together, and a second
  // round trip for a block that is usually collapsed would be a request nobody asked for.
  const archived = getCampaignHistory(store.id).map((c) => withCampaignStats(c, range));
  return json({ ok: true, campaigns, archived });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  let body: { storeSlug?: unknown; scope?: unknown; productId?: unknown; productIds?: unknown; categoryIds?: unknown; platform?: unknown; monthlyBudget?: unknown; durationDays?: unknown; audience?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (typeof body.storeSlug !== 'string') return json({ error: 'Missing storeSlug' }, 400);

  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, body.storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Scope/platform/budget validation — including which products or categories this store is
  // allowed to advertise — is shared with the admin twin (ad-campaign-input.ts).
  const built = buildCampaignInput(body, store);
  if (!built.ok) return json({ error: built.error }, built.status);

  const campaign = createCampaign(built.input);
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
  // The same check the POST path runs (lib/ad-budget.ts). A hardcoded `>= 50` here meant the two
  // paths could disagree — raise the floor and a seller could still PATCH an existing campaign
  // below it — and it had no ceiling at all, so `1e12` was a valid budget on this route.
  if (isValidCampaignBudget(monthlyBudget)) updates.monthlyBudget = roundMoney(monthlyBudget);
  if (status === 'active' || status === 'paused') updates.status = status;
  // Refused while the campaign has nothing to advertise, or nothing anyone can buy — the reason
  // travels as a code so the wording stays in the seller's language (ad-campaign-health.ts).
  if (status === 'active') {
    const blocked = resumeBlockReason(store.id, id);
    if (blocked) {
      const code = blocked === 'out-of-stock' ? 'CAMPAIGN_OUT_OF_STOCK'
        : blocked === 'ended' ? 'CAMPAIGN_ENDED'
        : 'CAMPAIGN_UNAVAILABLE';
      return json({ error: code }, 409);
    }
  }
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

  // Cancelled, not erased: the campaign stops and moves to the store's history, because the
  // spend it already accrued is part of figures that were reported for a month that is over
  // (ad-campaigns.ts#archiveCampaign).
  const archived = archiveCampaign(id, store.id);
  if (!archived) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true });
}
