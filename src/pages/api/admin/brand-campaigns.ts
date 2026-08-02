export const prerender = false;
import type { APIRoute } from 'astro';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { requireAdmin } from '../../../lib/admin-auth.js';
import {
  getAllBrandCampaigns,
  createBrandCampaign,
  updateBrandCampaign,
  deleteBrandCampaign,
  getMockBrandStats,
  parseCreateInput,
} from '../../../lib/brand-campaigns.js';

const json = { 'Content-Type': 'application/json' };

// Owner-managed platform BRAND campaigns (CURRENT_TASK.md → סשן ב׳). Admin-only.
// Nothing here moves money (no real ad API wired), so it's a plain settings-style
// CRUD; the mock stats stand in until a real Google/Meta account is connected.

export const GET: APIRoute = async ({ cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;
  const campaigns = getAllBrandCampaigns().map((c) => ({ ...c, stats: getMockBrandStats(c) }));
  return new Response(JSON.stringify({ campaigns }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;
  const read = await readJsonBody(request, BODY_LIMIT.form);
  const input = parseCreateInput(read.ok ? read.value : null);
  if (!input) return new Response(JSON.stringify({ error: 'Missing headline/body/budget' }), { status: 400, headers: json });
  const campaign = createBrandCampaign(input);
  return new Response(JSON.stringify({ ok: true, campaign, stats: getMockBrandStats(campaign) }), { headers: json });
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;
  const read = await readJsonBody<{ id?: string; monthlyBudget?: number; status?: 'active' | 'paused' }>(request, BODY_LIMIT.form);
  const body = read.ok ? read.value : null;
  if (!body?.id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: json });
  const updated = updateBrandCampaign(body.id, { monthlyBudget: body.monthlyBudget, status: body.status });
  if (!updated) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: json });
  return new Response(JSON.stringify({ ok: true, campaign: updated, stats: getMockBrandStats(updated) }), { headers: json });
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;
  const read = await readJsonBody<{ id?: string }>(request, BODY_LIMIT.control);
  const body = read.ok ? read.value : null;
  if (!body?.id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400, headers: json });
  const ok = deleteBrandCampaign(body.id);
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 404, headers: json });
};
