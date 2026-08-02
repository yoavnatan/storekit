export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { updatePlatformAdSettings, type PlatformAdSettings } from '../../../lib/platform-ads.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

const json = { 'Content-Type': 'application/json' };

// Owner-only knobs for the platform's baseline ad campaign (lifetime budget +
// active/paused), set from the admin Advertising tab. Admin-guarded. Nothing
// here moves real money — no real ad account is wired yet — so this stays a
// plain settings write (see platform-ads.ts).
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ baselineStatus?: unknown; lifetimeBudget?: unknown }>(request, BODY_LIMIT.control);
  const body = read.ok ? read.value : null;
  const updates: Partial<PlatformAdSettings> = {};

  if (body?.baselineStatus === 'active' || body?.baselineStatus === 'paused') {
    updates.baselineStatus = body.baselineStatus;
  }
  if (body?.lifetimeBudget !== undefined) {
    const budget = Number(body.lifetimeBudget);
    if (Number.isFinite(budget) && budget >= 0) updates.lifetimeBudget = Math.round(budget);
    else return new Response(JSON.stringify({ error: 'Invalid budget' }), { status: 400, headers: json });
  }

  const settings = updatePlatformAdSettings(updates);
  return new Response(JSON.stringify({ ok: true, settings }), { headers: json });
};
