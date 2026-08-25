import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { secretsEqual } from './secret-compare.js';
import { requiredSecret } from './runtime-env.js';
import { getSellerSession } from './seller-auth.js';
import { isAdminRequest } from './admin-auth.js';
import { BODY_LIMIT, readFormBody } from './request-body.js';
import { CSRF_FIELD, CSRF_HEADER } from './csrf-names.js';

/**
 * The DECIDING layer against cross-site request forgery, and since 2026-08-25 the only one that can
 * refuse a request. There were three; one is gone and it matters that the next reader knows which:
 *
 *   0. `sameSite: 'lax'` on every session cookie (seller-auth.ts, admin-auth.ts). **Still in place.**
 *      A modern browser does not attach a lax cookie to a cross-site POST at all, so the forged
 *      request arrives unauthenticated and the route's own 401 answers it. It is a floor rather than
 *      a gate — it costs an attacker the session, not the request.
 *   1. Astro's `security.checkOrigin`. **OFF.** It refused any form-encoded POST whose `Origin` was
 *      not ours, which is also the exact shape of a provider webhook — and it is one global boolean
 *      that runs BEFORE this file, so no exemption was possible from anywhere in `src/`. The full
 *      reasoning, the measurement, and what would have to be built before it can go back on are in
 *      astro.config.mjs beside the setting.
 *
 * So this file is now load-bearing rather than belt-and-braces. It was always the stronger of the
 * two — it covers every non-safe method and every content type rather than form-like bodies only,
 * and it checks a signed token bound to the caller rather than reading one header — but "stronger"
 * and "the only one" are different jobs, and the difference is `csrfExempt` below: the exemption
 * list is now the whole surface of the decision, which is why it is one path and why
 * `tests/csrf.test.ts` pins its contents rather than its behaviour.
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
 * **What it deliberately does NOT defend against, and what turning layer 1 off actually cost.** An
 * anonymous visitor's token binds to `-`, so any anonymous token is interchangeable with any other:
 * an attacker can mint one by visiting the site themselves and hard-code it into a form on their
 * own page. Layer 1 used to stop that form from being submitted at all. So the honest accounting is
 * that **anonymous, form-encoded forgery became possible** on 2026-08-25, and it was accepted after
 * walking every route it can reach rather than by assertion:
 *
 *   · Anything with privileges behind it binds to `s:<id>` or `a`, so an anonymous token is refused
 *     — the seller and admin routes, the buyer's cart and saved stores.
 *   · Every remaining anonymous write takes its authority from the BODY, not from the caller's
 *     cookies: `/api/checkout` from the cart it is sent, `/api/returns` and `/api/order-message`
 *     from an order credential (`order-access.ts`), `/api/review` from an order that covers the
 *     product. Making a stranger's browser send one buys the attacker nothing they could not send
 *     from their own machine, which is the definition of a request not worth forging.
 *   · What is left is nuisance with no privilege in it: `/api/lang` can flip a visitor's language
 *     cookie, `/api/analytics/event` can add a tally, `/api/log-client-error` can write a capped log
 *     line. Each is rate-limited or bounded on its own terms, and none of them is worth a layer that
 *     costs the payment webhook.
 *
 * Written out because "an anonymous session has no privileges" is true and is not the whole answer —
 * the next person to add an anonymous write path has to check their route against this list.
 *
 * **Where it is enforced: `src/middleware.ts`, and nowhere else.** One gate for every on-demand
 * route, in the same spirit as safe-redirect.ts and secret-compare.ts — a check copy-pasted per
 * route is a check that will be missing from the route added next month. `tests/csrf.test.ts`
 * greps `src/` to keep it that way.
 */

/** The names the token travels under live in `csrf-names.ts` — a module with no imports, so the
 *  BROWSER half (`src/scripts/csrf-client.ts`) can share them rather than write its own copies of
 *  the same two strings. Re-exported here so a server-side caller has one import, not two. */
export { CSRF_FIELD, CSRF_HEADER, CSRF_META } from './csrf-names.js';

/** Matches the seller session's own TTL (seller-auth.ts). A token that expired while its page was
 *  still open would reject a save with nothing on screen explaining why, and the session cookie it
 *  is bound to has died by then anyway — so there is nothing to be gained by expiring sooner. */
const TTL_SEC = 60 * 60 * 24 * 180;

/** RFC 9110 safe methods — they must not change state, so there is nothing to forge. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The paths allowed through WITHOUT a token — and there is exactly one.
 *
 * **An exemption from this check is not an exemption from proving who is calling.** Everything on
 * this list must authenticate itself, and the entry below does: a sale notification is verified
 * against `payme_signature` (MD5 over our client key, the seller's own callback secret and the two
 * ids, compared in `verifyCallbackSignature`) and refused if it does not match; a seller
 * notification carries no signature in PayMe's spec at all, so the route believes nothing in its
 * body and re-reads the truth over `get-sellers`, a call WE make with our own client key.
 *
 * ── Why the entry is a webhook, and why it could not simply be left out ──
 * A server-to-server POST comes from a machine that has never loaded a page of ours and cannot hold
 * a token, so this gate can only ever answer 403. Until 2026-08-25 the list was empty and this file
 * said the exemption belonged to `/api/payment/confirm` "when it is built" — but the webhook that
 * WAS built is `/api/payme/callback`, `checkout.ts` and `seller/subscription.ts` already register
 * it with PayMe as the callback URL, and nobody joined the two facts. Astro's `checkOrigin` refused
 * it one layer earlier for the same reason, which is why that setting is now off (astro.config.mjs
 * carries the whole trade). Measured against a real build, both before and after.
 *
 * ── Exact match, never a prefix ──
 * `startsWith` here would exempt `/api/payme/callback-anything` — a route nobody has written yet,
 * on the one list where a mistake is silent. `tests/csrf.test.ts` pins the list to this single path
 * and fails on a near miss.
 */
const CSRF_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/api/payme/callback']);

function csrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.has(pathname);
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
