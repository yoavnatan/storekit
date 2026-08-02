export const prerender = false;
import type { APIContext } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug } from '../../../lib/stores.js';
import { createCampaign, updateCampaign, archiveCampaign } from '../../../lib/ad-campaigns.js';
import { getCampaignsForStore, getCampaignHistory, resumeBlockReason } from '../../../lib/ad-campaign-health.js';
import { buildCampaignInput, isValidCampaignBudget } from '../../../lib/ad-campaign-input.js';
import { withCampaignStats } from '../../../lib/ad-metrics.js';
import { resolveAdRange } from '../../../lib/date-range.js';
import { roundMoney } from '../../../lib/money.js';

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
  const store = await getStoreBySlug(url.searchParams.get('storeSlug') ?? '');
  if (!store) return json({ error: 'Store not found' }, 404);

  // Same window/lifetime semantics as the seller route (shared resolveAdRange) so
  // the one picker (advertising.ts) drives both. lifetime/no-preset → lifetime.
  const range = resolveAdRange(url.searchParams);
  // await getCampaignsForStore (not the raw accessor): it attaches each campaign's health and pauses
  // any that has nothing left on the storefront to advertise (ad-campaign-health.ts).
  const campaigns = (await getCampaignsForStore(store.id)).map((c) => withCampaignStats(c, range));
  // History rides along in the same response: the two lists are rendered together, and a second
  // round trip for a block that is usually collapsed would be a request nobody asked for.
  const archived = (await getCampaignHistory(store.id)).map((c) => withCampaignStats(c, range));
  return json({ ok: true, campaigns, archived });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ storeSlug?: unknown; scope?: unknown; productId?: unknown; productIds?: unknown; categoryIds?: unknown; platform?: unknown; monthlyBudget?: unknown; durationDays?: unknown; audience?: unknown }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);
  const body = read.value;

  if (typeof body.storeSlug !== 'string') return json({ error: 'Missing storeSlug' }, 400);

  const store = await getStoreBySlug(body.storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Same validation the seller route runs (ad-campaign-input.ts) — one definition of which
  // products/categories a campaign may name, so the two routes can't drift apart.
  const built = await buildCampaignInput(body, store);
  if (!built.ok) return json({ error: built.error }, built.status);

  const campaign = createCampaign(built.input);
  return json({ ok: true, campaign: withCampaignStats(campaign) });
}

export async function PATCH({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ id?: unknown; storeSlug?: unknown; monthlyBudget?: unknown; status?: unknown }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);
  const body = read.value;

  const { id, storeSlug, monthlyBudget, status } = body;
  if (typeof id !== 'string' || typeof storeSlug !== 'string') return json({ error: 'Missing id or storeSlug' }, 400);

  const store = await getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const updates: Partial<{ monthlyBudget: number; status: 'active' | 'paused' }> = {};
  // Floor and ceiling from the module that owns them, same as the seller twin — see the note there.
  if (isValidCampaignBudget(monthlyBudget)) updates.monthlyBudget = roundMoney(monthlyBudget);
  if (status === 'active' || status === 'paused') updates.status = status;
  // Refused while the campaign has nothing to advertise, or nothing anyone can buy — the reason
  // travels as a code so the wording stays in the seller's language (ad-campaign-health.ts).
  if (status === 'active') {
    const blocked = await resumeBlockReason(store.id, id);
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
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ id?: unknown; storeSlug?: unknown }>(request, BODY_LIMIT.form);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);
  const body = read.value;

  const { id, storeSlug } = body;
  if (typeof id !== 'string' || typeof storeSlug !== 'string') return json({ error: 'Missing id or storeSlug' }, 400);

  const store = await getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Cancelled, not erased: the campaign stops and moves to the store's history, because the
  // spend it already accrued is part of figures that were reported for a month that is over
  // (ad-campaigns.ts#archiveCampaign).
  const archived = archiveCampaign(id, store.id);
  if (!archived) return json({ error: 'Campaign not found' }, 404);
  return json({ ok: true });
}
