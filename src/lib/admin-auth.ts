import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import { secretsEqual } from './secret-compare.js';

const COOKIE_NAME = 'admin_token';
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
 */
function adminSecret(): string {
  // `||` (not `??`) so a blank value counts as unset — otherwise an empty secret would match an
  // empty submitted password and read as authenticated.
  const configured = import.meta.env.ADMIN_SECRET;
  if (configured) return configured;
  if (import.meta.env.PROD) {
    throw new Error('ADMIN_SECRET is not set. Refusing to guard /admin with the public dev default.');
  }
  return 'admin';
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
function makeToken(): string {
  const payload = String(Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  // lastIndexOf, not split('.'): with split, `123.abc.def` would be read as payload `123` plus
  // signature `abc` with the tail silently ignored. Same parsing as seller-auth.ts.
  const lastDot = token.lastIndexOf('.');
  if (lastDot === -1) return false;
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!secretsEqual(sign(payload), sig)) return false;
  return Number(payload) > Math.floor(Date.now() / 1000);
}

export function isAdminRequest(cookies: AstroCookies): boolean {
  return verifyToken(cookies.get(COOKIE_NAME)?.value);
}

export function checkAdminPassword(password: string): boolean {
  return secretsEqual(password, adminSecret());
}

// path:'/' (not '/admin') so the cookie is also sent with /api/admin/* requests —
// a narrower path silently drops the cookie from any fetch() made off-page.
export function setAdminCookie(cookies: AstroCookies): void {
  cookies.set(COOKIE_NAME, makeToken(), {
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
