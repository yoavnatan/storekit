import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { secretsEqual } from './secret-compare.js';
import { requiredSecret } from './runtime-env.js';
import { getSellerSession } from './seller-auth.js';
import { isAdminRequest } from './admin-auth.js';
import { BODY_LIMIT, readFormBody } from './request-body.js';

/**
 * The SECOND layer against cross-site request forgery. The first two are already in place and are
 * not replaced by this file — say so out loud, because a defence-in-depth layer described as "the
 * protection" invites someone to remove one of the others:
 *
 *   1. `sameSite: 'lax'` on every session cookie (seller-auth.ts, admin-auth.ts). A modern browser
 *      does not attach a lax cookie to a cross-site POST at all, so the forged request arrives
 *      unauthenticated and the route's own 401 answers it.
 *   2. Astro's `security.checkOrigin` (astro.config.mjs, pinned explicitly there). It refuses any
 *      form-encoded, on-demand POST whose `Origin` is not our own.
 *
 * What this adds is that the protection stops depending on ONE framework default that a config
 * edit could flip, and it covers the shapes layer 2 deliberately does not test — Astro skips the
 * origin check entirely for a prerendered route, and skips it for a JSON body on the (correct, but
 * separate) reasoning that CORS preflight blocks that case in a browser. A signed token is checked
 * on its own terms and needs neither assumption to hold.
 *
 * **The token is signed, not stored, and it is BOUND to who is asking.** Payload is
 * `<binding>|<expiry>` plus an HMAC over it, so nothing has to be remembered between requests
 * (Hard rules → Scalability: stateless API routes, no shared write state — an instance that just
 * booted verifies a token minted by another one).
 *
 * The binding is the whole point. An unbound token would only prove "the sender has visited this
 * site once", which an attacker can do themselves — double-submit degenerates to nothing. Bound to
 * the session identity, a token minted for the attacker's own browser is rejected when replayed
 * against a victim's session.
 *
 * **What it deliberately does NOT defend against.** An anonymous visitor's token binds to `-`, so
 * any anonymous token is interchangeable with any other. That is accepted: an anonymous session has
 * no privileges to forge into, and layers 1 and 2 still stand behind it. It is written here so the
 * next reader does not mistake the gap for an oversight.
 *
 * **Where it is enforced: `src/middleware.ts`, and nowhere else.** One gate for every on-demand
 * route, in the same spirit as safe-redirect.ts and secret-compare.ts — a check copy-pasted per
 * route is a check that will be missing from the route added next month. `tests/csrf.test.ts`
 * greps `src/` to keep it that way.
 */

/** Where a client puts the token. The header is the AJAX path (see `src/scripts/csrf-client.ts`);
 *  the form field is the no-JS path for the handful of forms the browser really does submit
 *  itself (see `src/components/CsrfField.astro`). */
export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_FIELD = '_csrf';
/** The name of the `<meta>` tag BaseLayout renders the token into — the client's only source. */
export const CSRF_META = 'csrf-token';

/** Matches the seller session's own TTL (seller-auth.ts). A token that expired while its page was
 *  still open would reject a save with nothing on screen explaining why, and the session cookie it
 *  is bound to has died by then anyway — so there is nothing to be gained by expiring sooner. */
const TTL_SEC = 60 * 60 * 24 * 180;

/** RFC 9110 safe methods — they must not change state, so there is nothing to forge. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Is this path allowed through WITHOUT a token?
 *
 * Nothing is, today, and that is a statement rather than a stub: every mutating endpoint this
 * application has is called by one of our own pages. The case this predicate exists for is the
 * payment provider's webhook (`/api/payment/confirm`, GO_LIVE_CHECKLIST.md §3) — a server-to-server
 * POST from a machine that has never loaded a page of ours and cannot hold a token. When it is
 * built it belongs here, and it must bring its OWN authentication (a provider signature, compared
 * through `secretsEqual`): an exemption from this check is not an exemption from proving who is
 * calling.
 */
function csrfExempt(_pathname: string): boolean {
  return false;
}

/**
 * The signing key is derived from `AUTH_SECRET` rather than being it, matching admin-auth.ts: the
 * same secret already signs session tokens, and one value serving two cryptographic roles means a
 * weakness in either use becomes a weakness in both. Read through `requiredSecret` — never
 * `import.meta.env` — for the reason in runtime-env.ts's header.
 */
function sign(payload: string): string {
  return crypto.createHmac('sha256', `${requiredSecret('AUTH_SECRET', 'dev-insecure-secret')}::csrf`)
    .update(payload).digest('hex');
}

/**
 * Who this request is, as one short string.
 *
 * Computed identically when a token is minted and when it is verified, which is the only property
 * that matters: the two calls happen in different requests and must agree. A seller wins over the
 * admin flag when a browser somehow holds both cookies — an arbitrary but FIXED choice, and fixed
 * is what keeps mint and verify in step.
 */
function binding(cookies: AstroCookies): string {
  const sellerId = getSellerSession(cookies);
  if (sellerId) return `s:${sellerId}`;
  return isAdminRequest(cookies) ? 'a' : '-';
}

/** A token for whoever this request is. Cheap enough to call per render — one HMAC. */
export function issueCsrfToken(cookies: AstroCookies): string {
  const payload = `${binding(cookies)}|${Math.floor(Date.now() / 1000) + TTL_SEC}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Signature, expiry, and binding — all three, in that order.
 *
 * `lastIndexOf`, not `split`, for both separators: with `split('.')` a token of
 * `s:id|123.abc.def` would be read as payload `s:id|123` with signature `abc` and the tail
 * silently ignored. Same parsing bug the session modules already document.
 */
export function verifyCsrfToken(token: string | null | undefined, cookies: AstroCookies): boolean {
  if (!token) return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;
  const payload = token.slice(0, lastDot);
  if (!secretsEqual(sign(payload), token.slice(lastDot + 1))) return false;

  const sep = payload.lastIndexOf('|');
  if (sep === -1) return false;
  const expiry = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;

  // Not a secret comparison — the binding is a session id this process already holds, and the
  // signature check above is what an attacker would have to beat first.
  return payload.slice(0, sep) === binding(cookies);
}

/** Does this request have to prove itself? Method first (it is free), then the exemption. */
export function csrfRequired(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !csrfExempt(pathname);
}

/**
 * The token the caller sent: the header, or — only for a body the BROWSER encoded itself — the
 * hidden form field.
 *
 * **Reading the body here is safe specifically because it reads a CLONE.** `request.clone()` tees
 * the stream, so the route that runs afterwards still gets its own `formData()`; consuming
 * `request` itself would leave every native form POST with an empty body and no clue why.
 * `tests/csrf.test.ts` asserts that tee against the real runtime rather than trusting the spec.
 *
 * And it goes through `readFormBody`, not `clone.formData()`, for the reason that module exists:
 * `formData()` buffers whatever arrives with no ceiling, so a chunked body that declares no length
 * would be read in full here. Bodies on this path are login/logout/language forms — tens of bytes.
 *
 * A `multipart/form-data` body is deliberately NOT read: those are AJAX uploads in this codebase
 * (product photos, CSV imports), they carry the header, and buffering a file upload in middleware
 * to look for a field that was never put there is exactly the cost the cap exists to refuse.
 */
export async function csrfTokenFromRequest(request: Request): Promise<string | null> {
  const header = request.headers.get(CSRF_HEADER);
  if (header) return header;

  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/x-www-form-urlencoded')) return null;

  try {
    const read = await readFormBody(request.clone(), BODY_LIMIT.form);
    return read.ok ? read.value.get(CSRF_FIELD) || null : null;
  } catch {
    return null;
  }
}

/**
 * A plain 403 with a plain reason. Deliberately not a redirect and not a JSON error shape: this
 * answers a request the user did not knowingly make, and every legitimate caller in this
 * application carries a token, so there is no flow to be gentle with. Not logged either — a
 * forgery attempt is repeatable at whatever rate the attacker likes, and the Alerts tab is for
 * things the owner can act on.
 */
export function csrfRejection(): Response {
  return new Response('CSRF token missing or invalid', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
