import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';

const COOKIE_NAME = 'admin_session';
const ONE_DAY = 60 * 60 * 24;

function secret(): string {
  return import.meta.env.AUTH_SECRET || 'dev-insecure-secret';
}

function sign(value: string): string {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}

function makeToken(): string {
  const payload = String(Math.floor(Date.now() / 1000) + ONE_DAY);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (sign(payload!) !== sig) return false;
  return Number(payload) > Math.floor(Date.now() / 1000);
}

export function checkCredentials(username: string, password: string): boolean {
  const u = import.meta.env.ADMIN_USERNAME || 'admin';
  const p = import.meta.env.ADMIN_PASSWORD || 'admin';
  return username === u && password === p;
}

export function login(cookies: AstroCookies): void {
  cookies.set(COOKIE_NAME, makeToken(), {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_DAY,
  });
}

export function logout(cookies: AstroCookies): void {
  cookies.delete(COOKIE_NAME, { path: '/' });
}

export function isAuthenticated(cookies: AstroCookies): boolean {
  return verifyToken(cookies.get(COOKIE_NAME)?.value);
}
