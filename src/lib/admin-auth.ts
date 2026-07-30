import type { AstroCookies } from 'astro';
import { secretsEqual } from './secret-compare.js';

const COOKIE_NAME = 'admin_token';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

function adminSecret(): string {
  // `||` (not `??`) so an empty-string env var also falls back to the
  // default — otherwise a blank ADMIN_SECRET would make every anonymous
  // request (empty cookie) match an empty secret and read as authenticated.
  return import.meta.env.ADMIN_SECRET || 'admin';
}

export function isAdminRequest(cookies: AstroCookies): boolean {
  return secretsEqual(cookies.get(COOKIE_NAME)?.value ?? '', adminSecret());
}

export function checkAdminPassword(password: string): boolean {
  return secretsEqual(password, adminSecret());
}

// path:'/' (not '/admin') so the cookie is also sent with /api/admin/* requests —
// a narrower path silently drops the cookie from any fetch() made off-page.
export function setAdminCookie(cookies: AstroCookies): void {
  cookies.set(COOKIE_NAME, adminSecret(), {
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
