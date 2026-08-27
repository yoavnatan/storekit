import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { secretsEqual } from './secret-compare.js';
import { requiredSecret } from './runtime-env.js';

/**
 * `admin_token2`, and the rename is the migration.
 *
 * The token's payload gained a ROLE (below). A cookie minted before that carries only an expiry,
 * and there is no honest way to read a role out of it: it might have come from the password or
 * from the demonstration's tour door, which called the same function. Defaulting such a cookie
 * either way is a guess about who is holding it. Changing the name retires every one of them at
 * once — the cost is that anybody signed in has to sign in again, which is a login form, and the
 * alternative is a guess about an admin session.
 */
const COOKIE_NAME = 'admin_token2';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

/**
 * The admin password, and the root of the key the session cookie is signed with.
 *
 * A missing ADMIN_SECRET in production is a HARD FAILURE, not a fallback. This used to default
 * to the literal `'admin'` in every environment while `.env.example` documented
 * `ADMIN_USERNAME`/`ADMIN_PASSWORD` instead — variables read only by a dead module — so an
 * operator who carefully replaced every password in that file would still have shipped an admin
 * area whose password was `admin`. The throw lands on the first request that touches /admin
 * rather than at boot, which is loud where it matters and impossible to mistake for a login
 * failure. Mirrors `secret()` in seller-auth.ts, which had this guard already.
 *
 * Read via `requiredSecret` (runtime-env.ts), never `import.meta.env.ADMIN_SECRET` — the latter
 * is inlined at build time, so a secret supplied only to the running server would be invisible
 * and this guard would throw on every /admin request instead.
 */
function adminSecret(): string {
  // A blank value counts as unset — otherwise an empty secret would match an empty submitted
  // password and read as authenticated.
  return requiredSecret('ADMIN_SECRET', 'admin');
}

/**
 * The signing key is derived from the secret rather than being it: that same value is also the
 * login password, and one value serving two cryptographic roles means a weakness in either use
 * becomes a weakness in both.
 */
function sign(value: string): string {
  return crypto.createHmac('sha256', `${adminSecret()}::admin-session`).update(value).digest('hex');
}

/**
 * The cookie carries a signed expiry, NOT the secret. It used to hold `adminSecret()` verbatim,
 * which made the cookie itself the permanent master credential: anything that ever saw it (a
 * proxy log, a shared browser, a backup) had admin access indefinitely, and no session could be
 * expired without changing the password for everyone.
 */
/**
 * What an admin session is allowed to DO, carried inside the signature.
 *
 * `owner` came from the password. `viewer` came from the portfolio demonstration's tour door, which
 * hands out an admin session to anybody who presses it — so it must not be able to block a store,
 * clear the error log or delete a conversation. Enforced in `lib/demo-viewer.ts`, which is the one
 * place that decides; this file's job is only to say, unforgeably, which kind of session this is.
 *
 * Inside the SIGNED payload rather than beside it: a role in a separate cookie, or in the same
 * cookie outside the HMAC, is a role anybody can edit.
 */
export type AdminRole = 'owner' | 'viewer';

function makeToken(role: AdminRole): string {
  const payload = `${Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE}|${role}`;
  return `${payload}.${sign(payload)}`;
}

/** The session's role, or null when there is no valid session at all. */
function readToken(token: string | undefined): AdminRole | null {
  if (!token) return null;
  // lastIndexOf, not split('.'): with split, `123.abc.def` would be read as payload `123` plus
  // signature `abc` with the tail silently ignored. Same parsing as seller-auth.ts.
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!secretsEqual(sign(payload), sig)) return null;
  const [exp, role] = payload.split('|');
  if (!(Number(exp) > Math.floor(Date.now() / 1000))) return null;
  // Anything that is not the word `owner` is a viewer. The default leans to LESS power on an
  // unreadable payload, which is the only direction a guess about an admin session may lean.
  return role === 'owner' ? 'owner' : 'viewer';
}

export function isAdminRequest(cookies: AstroCookies): boolean {
  return adminRole(cookies) !== null;
}

/** Which kind of admin session this is, or null for none. The one reader of the role. */
export function adminRole(cookies: AstroCookies): AdminRole | null {
  return readToken(cookies.get(COOKIE_NAME)?.value);
}

export function checkAdminPassword(password: string): boolean {
  return secretsEqual(password, adminSecret());
}

// path:'/' (not '/admin') so the cookie is also sent with /api/admin/* requests —
// a narrower path silently drops the cookie from any fetch() made off-page.
export function setAdminCookie(cookies: AstroCookies, role: AdminRole = 'owner'): void {
  cookies.set(COOKIE_NAME, makeToken(role), {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

export function clearAdminCookie(cookies: AstroCookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}

export function requireAdmin(cookies: AstroCookies): Response | null {
  if (isAdminRequest(cookies)) return null;
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
