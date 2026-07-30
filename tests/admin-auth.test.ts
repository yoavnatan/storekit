// The /admin gate. Every assertion here is a hole that was actually open:
//
//  - ADMIN_SECRET had no production guard and defaulted to the literal 'admin', while
//    .env.example documented ADMIN_USERNAME/ADMIN_PASSWORD — variables read only by
//    src/lib/auth.ts, a module nothing imported. Following the documentation exactly still
//    shipped an admin area whose password was 'admin'.
//  - The cookie held the secret verbatim, so the cookie WAS the permanent credential.
//  - The signing key and the login password were the same value.
//
// The source is asserted as text where the behaviour depends on import.meta.env.PROD, which
// vitest cannot flip per-test without reloading the module graph. That is the same approach
// tests/seller-auth-password.test.ts already takes for its own PROD guard.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import type { AstroCookies } from 'astro';
import {
  checkAdminPassword, clearAdminCookie, isAdminRequest, requireAdmin, setAdminCookie,
} from '../src/lib/admin-auth.js';

const SRC = readFileSync(fileURLToPath(new URL('../src/lib/admin-auth.ts', import.meta.url)), 'utf8');
const DEV_SECRET = 'admin'; // the dev fallback, which is what these tests run against

/** Minimal stand-in for AstroCookies: enough surface for the four functions under test. */
function fakeCookies(initial: Record<string, string> = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
    jar,
  } as unknown as AstroCookies & { jar: Map<string, string> };
}

describe('the production guard on ADMIN_SECRET', () => {
  it('throws rather than falling back to a default when unset in production', () => {
    expect(SRC).toMatch(/import\.meta\.env\.PROD[\s\S]{0,200}throw new Error\('ADMIN_SECRET is not set/);
  });

  it('treats a blank value as unset, so an empty password cannot authenticate', () => {
    // `||` and not `??`: with `??` a blank ADMIN_SECRET would be a real (empty) secret.
    expect(SRC).toMatch(/const configured = import\.meta\.env\.ADMIN_SECRET;\s*\n\s*if \(configured\)/);
    expect(SRC).not.toMatch(/ADMIN_SECRET \?\?/);
    expect(checkAdminPassword('')).toBe(false);
  });
});

describe('checkAdminPassword', () => {
  it('accepts the configured secret and nothing else', () => {
    expect(checkAdminPassword(DEV_SECRET)).toBe(true);
    expect(checkAdminPassword('Admin')).toBe(false);
    expect(checkAdminPassword('admin ')).toBe(false);
    expect(checkAdminPassword('admin-extra')).toBe(false);
  });

  it('compares in constant time, not with ===', () => {
    expect(SRC).toMatch(/secretsEqual\(password, adminSecret\(\)\)/);
    expect(SRC).not.toMatch(/password === /);
  });
});

describe('the session cookie', () => {
  it('does not contain the secret', () => {
    const cookies = fakeCookies();
    setAdminCookie(cookies);
    const value = cookies.jar.get('admin_token')!;
    expect(value).toBeTruthy();
    expect(value).not.toContain(DEV_SECRET);
    expect(value).not.toBe(DEV_SECRET);
  });

  it('is accepted by isAdminRequest after being set', () => {
    const cookies = fakeCookies();
    expect(isAdminRequest(cookies)).toBe(false);
    setAdminCookie(cookies);
    expect(isAdminRequest(cookies)).toBe(true);
  });

  it('carries an expiry that is signed, so it cannot be extended by the holder', () => {
    const cookies = fakeCookies();
    setAdminCookie(cookies);
    const [exp, sig] = cookies.jar.get('admin_token')!.split('.');
    expect(Number(exp)).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Push the expiry far into the future, keep the signature: must be rejected.
    const forged = `${Number(exp) + 10_000_000}.${sig}`;
    expect(isAdminRequest(fakeCookies({ admin_token: forged }))).toBe(false);
  });

  it('rejects an expired token even though its signature is valid', () => {
    const past = String(Math.floor(Date.now() / 1000) - 60);
    const sig = crypto.createHmac('sha256', `${DEV_SECRET}::admin-session`).update(past).digest('hex');
    expect(isAdminRequest(fakeCookies({ admin_token: `${past}.${sig}` }))).toBe(false);
  });

  it('rejects a tampered signature, a missing signature and junk', () => {
    for (const value of ['', '.', 'nodot', '9999999999.', '9999999999.deadbeef', 'admin']) {
      expect(isAdminRequest(fakeCookies({ admin_token: value })), value).toBe(false);
    }
  });

  it('splits a multi-dot token at the LAST dot, so a valid token cannot carry a tail', () => {
    const exp = String(Math.floor(Date.now() / 1000) + 100);
    const sig = crypto.createHmac('sha256', `${DEV_SECRET}::admin-session`).update(exp).digest('hex');
    expect(isAdminRequest(fakeCookies({ admin_token: `${exp}.${sig}` }))).toBe(true);

    // Appending anything to a valid token must invalidate it. Under `split('.')` the payload
    // would still read as `exp` and the signature as `sig`, with the tail silently dropped —
    // so this exact value would have authenticated.
    expect(isAdminRequest(fakeCookies({ admin_token: `${exp}.${sig}.anything` }))).toBe(false);
    expect(SRC).toMatch(/lastIndexOf\('\.'\)/);
    expect(SRC).not.toMatch(/token\.split\('\.'\)/);
  });

  it('derives the signing key rather than signing with the password itself', () => {
    expect(SRC).toMatch(/createHmac\('sha256', `\$\{adminSecret\(\)\}::admin-session`\)/);
    const payload = String(Math.floor(Date.now() / 1000) + 100);
    const naive = crypto.createHmac('sha256', DEV_SECRET).update(payload).digest('hex');
    expect(isAdminRequest(fakeCookies({ admin_token: `${payload}.${naive}` }))).toBe(false);
  });

  it('is cleared on logout', () => {
    const cookies = fakeCookies();
    setAdminCookie(cookies);
    clearAdminCookie(cookies);
    expect(isAdminRequest(cookies)).toBe(false);
  });

  it('is set httpOnly and scoped to / so /api/admin/* still receives it', () => {
    expect(SRC).toMatch(/httpOnly: true/);
    expect(SRC).toMatch(/path: '\/'/);
  });
});

describe('requireAdmin', () => {
  it('401s an anonymous caller and passes an authenticated one through', async () => {
    const denied = requireAdmin(fakeCookies());
    expect(denied?.status).toBe(401);
    await expect(denied!.json()).resolves.toEqual({ error: 'Unauthorized' });

    const cookies = fakeCookies();
    setAdminCookie(cookies);
    expect(requireAdmin(cookies)).toBeNull();
  });
});

describe('the dead second admin-auth module', () => {
  it('stays deleted, and its env vars stay out of .env.example', () => {
    // src/lib/auth.ts was a whole parallel admin login nothing imported. Its presence is what
    // made ADMIN_USERNAME/ADMIN_PASSWORD look live in the documentation.
    const url = new URL('../src/lib/auth.ts', import.meta.url);
    expect(() => readFileSync(fileURLToPath(url), 'utf8')).toThrow();

    const env = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
    expect(env).toContain('ADMIN_SECRET=');
    expect(env).not.toMatch(/^ADMIN_USERNAME=/m);
    expect(env).not.toMatch(/^ADMIN_PASSWORD=/m);
  });
});
