// Google sign-in was offered unconditionally: both auth pages rendered "continue with Google"
// while /api/auth/google answered a bare `503 Google OAuth not configured`, and GOOGLE_CLIENT_ID
// has never been set — so the most prominent button on the login page was a dead end. The config
// question now has one owner (lib/google-oauth.ts) and the pages ask it.

import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { isGoogleAuthEnabled, googleRedirectUri, googleClientId } from '../src/lib/google-oauth.js';

const KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

const page = (name: string) =>
  readFileSync(new URL(`../src/pages/seller/${name}.astro`, import.meta.url), 'utf8');

describe('isGoogleAuthEnabled', () => {
  it('is false with nothing configured', () => {
    expect(isGoogleAuthEnabled()).toBe(false);
  });

  it('needs the secret too, not just the client id', () => {
    // With an id but no secret the seller reaches Google and fails on the way back — worse than
    // never offering the button.
    process.env.GOOGLE_CLIENT_ID = 'id.apps.googleusercontent.com';
    expect(googleClientId()).toBe('id.apps.googleusercontent.com');
    expect(isGoogleAuthEnabled()).toBe(false);
  });

  it('is true once both halves are present', () => {
    process.env.GOOGLE_CLIENT_ID = 'id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'shh';
    expect(isGoogleAuthEnabled()).toBe(true);
  });
});

describe('googleRedirectUri', () => {
  it('defaults to this app\'s callback on the requesting origin', () => {
    expect(googleRedirectUri('https://dezabin.co.il')).toBe('https://dezabin.co.il/api/auth/google/callback');
  });

  it('is overridable, for a proxy that rewrites the host', () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://proxied.example/cb';
    expect(googleRedirectUri('https://dezabin.co.il')).toBe('https://proxied.example/cb');
  });
});

describe('the auth pages', () => {
  it.each(['login', 'register'])('%s gates the Google button on the shared check', (name) => {
    const src = page(name);
    expect(src).toMatch(/isGoogleAuthEnabled/);
    expect(src).toMatch(/\{googleEnabled && \(/);
    // The divider belongs inside the gate too — on its own it would announce an alternative that
    // isn't there.
    expect(src).toMatch(/\{googleEnabled && \([\s\S]*?auth-divider[\s\S]*?\)\}/);
  });
});
