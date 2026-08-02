export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { updatePlatformAdSettings, parseLifetimeBudgetAgorot, type PlatformAdSettings } from '../../../lib/platform-ads.js';
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
  // Shekels in, agorot stored. The ceiling is the point of the shared parser: this route used to
  // accept any finite number, so `1e30` was a valid lifetime budget and there is no column CHECK
  // behind a jsonb value to catch it (platform-ads.ts).
  if (body?.lifetimeBudget !== undefined) {
    const budget = parseLifetimeBudgetAgorot(body.lifetimeBudget);
    if (budget === null) return new Response(JSON.stringify({ error: 'Invalid budget' }), { status: 400, headers: json });
    updates.lifetimeBudgetAgorot = budget;
  }

  const settings = await updatePlatformAdSettings(updates);
  return new Response(JSON.stringify({ ok: true, settings }), { headers: json });
};
