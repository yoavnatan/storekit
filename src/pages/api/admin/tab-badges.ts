export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getAllLastViewedAt } from '../../../lib/admin-tab-views.js';
import { getAdminTabBadges } from '../../../lib/admin-tab-badges.js';

/**
 * The tab badges on their own, as JSON — so the dashboard can keep them current without reloading.
 *
 * **Why this exists as an endpoint rather than riding along with a panel swap.** The badge's entire
 * job is to report a tab the admin is NOT looking at (owner, 2026-08-07: it has to tell me something
 * changed where I'm not looking, live). Tying its freshness to panel swaps would mean the one admin
 * who sits on a single tab and never filters anything — exactly the person the badge is for — sees
 * a number frozen at page load. Two `COUNT` statements' worth of work in one round trip, so polling
 * it costs about what a `SELECT 1` costs.
 *
 * It reads the boundary and never advances it. `POST /api/admin/tab-view` is still the only writer;
 * a badge that cleared itself by being looked at would be reporting nothing at all.
 */
export const GET: APIRoute = async ({ cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const badges = await getAdminTabBadges(await getAllLastViewedAt());
  return new Response(JSON.stringify(badges), {
    // Never cached: a stale badge is a badge that lies about the thing it exists to report, and a
    // shared cache must not hold an admin-only answer at all.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
