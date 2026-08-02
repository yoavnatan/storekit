export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getRecentErrors, clearErrorLog, setErrorResolved } from '../../../lib/error-log.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

const json = { 'Content-Type': 'application/json' };

export const GET: APIRoute = async ({ cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;
  return new Response(JSON.stringify({ errors: getRecentErrors() }), { headers: json });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ action?: string; id?: string; resolved?: unknown }>(request, BODY_LIMIT.control);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid body' }), { status: read.status, headers: json });
  const body = read.value;
  if (body.action === 'clear') {
    clearErrorLog();
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }
  if (body.action === 'resolve') {
    const id = String(body.id ?? '');
    const ok = id ? setErrorResolved(id, Boolean(body.resolved)) : false;
    if (!ok) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: json });
    return new Response(JSON.stringify({ ok: true }), { headers: json });
  }
  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: json });
};
