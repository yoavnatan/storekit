export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { recordTabView, isTrackedAdminTab } from '../../../lib/admin-tab-views.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

// Called client-side when the admin switches tabs (initDashTabs() in ui.ts
// is a pure client-side hidden-attribute toggle, no server round-trip — see
// src/scripts/admin/tab-nav.ts) so "last viewed" still updates mid-session
// even though the dashboard tab switch itself never re-hits the server.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ tab?: string }>(request, BODY_LIMIT.control);
  const body = read.ok ? read.value : null;
  const tab = body?.tab;
  if (!isTrackedAdminTab(tab)) {
    return new Response(JSON.stringify({ error: 'invalid tab' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Awaited, unlike the error log: the admin's very next page load reads this boundary back, so
  // answering `ok` before it is stored would show the badge they just cleared.
  await recordTabView(tab);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
