import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { APIContext } from 'astro';

// **Account takeover through Google sign-in (closed 2026-08-06).**
//
// The callback fetched `verified_email` from Google's userinfo and then never looked at it. The
// branch below it links a Google identity into an EXISTING account whenever the addresses match —
// so an account whose address Google has not verified was a complete takeover of whichever seller
// owns that address: their stores, their orders, their revenue figures, their payout identity.
//
// The check is `!== true`, not `=== false`: a response that simply omits the field has verified
// nothing either, and Google is not the only thing that can answer this URL in a misconfigured
// deployment.

const linkGoogleAccount = vi.fn(async (_sellerId: string, _googleId: string) => {});
const createGoogleSeller = vi.fn(async () => ({ id: 'new', name: 'N', email: 'e', passwordHash: '', createdAt: '' }));
const setSellerSession = vi.fn(() => {});

let USERINFO: Record<string, unknown>;

vi.mock('../src/lib/seller-auth.js', () => ({
  getSellerByGoogleId: async () => null,
  // The victim: an existing password account on the address the Google profile claims.
  getSellerByEmail: async () => ({ id: 'victim', name: 'Victim', email: 'victim@example.com', passwordHash: 'x', createdAt: '' }),
  createGoogleSeller: () => createGoogleSeller(),
  linkGoogleAccount: (a: string, b: string) => linkGoogleAccount(a, b),
  setSellerSession: () => setSellerSession(),
}));
vi.mock('../src/lib/google-oauth.js', () => ({
  googleClientId: () => 'id.apps.googleusercontent.com',
  googleClientSecret: () => 'shh',
  googleRedirectUri: () => 'https://dezabin.co.il/api/auth/google/callback',
}));
vi.mock('../src/lib/outbound-fetch.js', () => ({
  outboundFetch: async (target: string) => ({
    json: async () => (target.includes('/token')
      ? { access_token: 'tok' }
      : USERINFO),
  }),
}));

const { GET } = await import('../src/pages/api/auth/google/callback.js');

function ctx(): APIContext {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });
  return {
    url: new URL('https://dezabin.co.il/api/auth/google/callback?code=c&state=st'),
    cookies: {
      get: (name: string) => (name === 'oauth_state' ? { value: 'st' } : undefined),
      delete: () => {},
      set: () => {},
    } as unknown as APIContext['cookies'],
    redirect,
  } as unknown as APIContext;
}

const location = (res: Response) => res.headers.get('Location') ?? '';

beforeEach(() => {
  linkGoogleAccount.mockClear();
  createGoogleSeller.mockClear();
  setSellerSession.mockClear();
  USERINFO = { id: 'g1', email: 'victim@example.com', name: 'Attacker', verified_email: true };
});

describe('GET /api/auth/google/callback — the address must be one Google verified', () => {
  it('control: a verified address links and signs in, as it always did', async () => {
    const res = await GET(ctx());
    expect(linkGoogleAccount).toHaveBeenCalledWith('victim', 'g1');
    expect(setSellerSession).toHaveBeenCalled();
    expect(location(res)).toBe('/seller/dashboard');
  });

  it('refuses an UNVERIFIED address — no link, no session, no account created', async () => {
    USERINFO = { ...USERINFO, verified_email: false };
    const res = await GET(ctx());
    expect(linkGoogleAccount).not.toHaveBeenCalled();
    expect(createGoogleSeller).not.toHaveBeenCalled();
    expect(setSellerSession).not.toHaveBeenCalled();
    expect(location(res)).toBe('/seller/login?error=oauth_unverified_email');
  });

  it('treats a MISSING verified_email the same way — absence is not proof', async () => {
    USERINFO = { id: 'g1', email: 'victim@example.com', name: 'Attacker' };
    const res = await GET(ctx());
    expect(linkGoogleAccount).not.toHaveBeenCalled();
    expect(setSellerSession).not.toHaveBeenCalled();
    expect(location(res)).toBe('/seller/login?error=oauth_unverified_email');
  });

  it('does not accept a truthy non-boolean either', async () => {
    USERINFO = { ...USERINFO, verified_email: 'true' };
    const res = await GET(ctx());
    expect(setSellerSession).not.toHaveBeenCalled();
    expect(location(res)).toBe('/seller/login?error=oauth_unverified_email');
  });
});
