export const prerender = false;
import type { APIRoute } from 'astro';
import { logError, resolveErrorContext } from '../../lib/error-log.js';
import { readJsonBody } from '../../lib/request-body.js';

const MAX_MESSAGE_LEN = 500;
const MAX_STACK_LEN = 2000;
// Generous ceiling on the raw request body itself, enforced against the bytes that actually arrive
// — the per-field caps below only trim AFTER parsing, so without this an unauthenticated sender
// chooses how much memory a JSON.parse here allocates (request-body.ts says why the
// `Content-Length` header this used to read is not the same check).
const MAX_BODY_BYTES = 20_000;

// Intentionally unauthenticated — any page (buyer, seller, or anonymous
// visitor) can report a client-side JS error here. Only the admin-guarded
// GET/clear in api/admin/errors.ts requires a login.
export const POST: APIRoute = async ({ request, cookies }) => {
  const read = await readJsonBody(request, MAX_BODY_BYTES);
  if (!read.ok) return new Response(null, { status: read.status });
  const body = read.value;

  const message = typeof (body as { message?: unknown })?.message === 'string'
    ? (body as { message: string }).message.slice(0, MAX_MESSAGE_LEN)
    : '';
  if (!message) return new Response(null, { status: 400 });

  const stackRaw = (body as { stack?: unknown })?.stack;
  const stack = typeof stackRaw === 'string' ? stackRaw.slice(0, MAX_STACK_LEN) : undefined;
  const routeRaw = (body as { route?: unknown })?.route;
  const route = typeof routeRaw === 'string' ? routeRaw.slice(0, 200) : undefined;

  logError({
    source: 'client',
    message,
    stack,
    route,
    ...(await resolveErrorContext(route ?? '', cookies)),
  });
  return new Response(null, { status: 204 });
};
