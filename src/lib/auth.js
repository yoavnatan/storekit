/**
 * AUTH — minimal admin authentication.
 *
 * Strategy: a signed, HTTP-only cookie. On login we compare the submitted
 * credentials with the env values (ADMIN_USERNAME / ADMIN_PASSWORD) and,
 * on success, set a cookie signed with AUTH_SECRET. Admin pages call
 * `isAuthenticated(cookies)` and redirect to /admin/login if false.
 *
 * This is intentionally dependency-free. For production-grade auth you may
 * later swap this for a real provider — the page-level API stays the same.
 */

import crypto from 'node:crypto';

const COOKIE_NAME = 'admin_session';
const ONE_DAY = 60 * 60 * 24;

function secret() {
  return import.meta.env.AUTH_SECRET || 'dev-insecure-secret';
}

function sign(value) {
  const hmac = crypto.createHmac('sha256', secret());
  hmac.update(value);
  return hmac.digest('hex');
}

/** Build the cookie token: "<payload>.<signature>" */
function makeToken() {
  // expiry timestamp as payload; cheap and stateless.
  const payload = String(Math.floor(Date.now() / 1000) + ONE_DAY);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return false;
  return Number(payload) > Math.floor(Date.now() / 1000);
}

/** Check submitted credentials against env config. */
export function checkCredentials(username, password) {
  const u = import.meta.env.ADMIN_USERNAME || 'admin';
  const p = import.meta.env.ADMIN_PASSWORD || 'admin';
  return username === u && password === p;
}

/** Set the session cookie on a successful login. */
export function login(cookies) {
  cookies.set(COOKIE_NAME, makeToken(), {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_DAY,
  });
}

export function logout(cookies) {
  cookies.delete(COOKIE_NAME, { path: '/' });
}

/** True if the request carries a valid admin session cookie. */
export function isAuthenticated(cookies) {
  const token = cookies.get(COOKIE_NAME)?.value;
  return verifyToken(token);
}
