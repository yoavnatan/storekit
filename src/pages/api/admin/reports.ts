export const prerender = false;
import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { setReportHandled } from '../../../lib/user-reports.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';

const json = { 'Content-Type': 'application/json' };

/**
 * The admin's half of "דווח על תקלה": marking one handled, and putting it back if that was a
 * misclick.
 *
 * No `clear` action, deliberately — unlike the error log beside it, which is machine-written noise
 * an admin is allowed to wipe. A person wrote every row here, and "handled" is the only state
 * change this screen needs; deleting one would be deleting the only copy of what they said.
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const read = await readJsonBody<{ id?: unknown; handled?: unknown }>(request, BODY_LIMIT.control);
  if (!read.ok) return new Response(JSON.stringify({ error: 'Invalid body' }), { status: read.status, headers: json });

  const id = typeof read.value.id === 'string' ? read.value.id : '';
  // `await` before the truthiness test: an unawaited promise is truthy, so the 404 would never fire
  // and a bad id would answer 200 (the same trap `api/admin/errors.ts` carries).
  const ok = id ? await setReportHandled(id, Boolean(read.value.handled)) : false;
  if (!ok) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: json });
  return new Response(JSON.stringify({ ok: true }), { headers: json });
};
