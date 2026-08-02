export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { recordTabView, type TrackedAdminTab } from '../../../lib/admin-tab-views.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

const TRACKED_TABS = new Set<TrackedAdminTab>(['sellers', 'stores', 'orders', 'alerts']);

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
  if (!tab || !TRACKED_TABS.has(tab as TrackedAdminTab)) {
    return new Response(JSON.stringify({ error: 'invalid tab' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  recordTabView(tab as TrackedAdminTab);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
