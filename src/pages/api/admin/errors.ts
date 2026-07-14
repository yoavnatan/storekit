export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getRecentErrors, clearErrorLog } from '../../../lib/error-log.js';

const json = { 'Content-Type': 'application/json' };

export const GET: APIRoute = async ({ cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;
  return new Response(JSON.stringify({ errors: getRecentErrors() }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const body = await request.json();
  if (body.action === 'clear') {
    clearErrorLog();
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }
  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: json });
};
