export const prerender = false;
import type { APIRoute } from 'astro';
import {
  getSellerByGoogleId,
  getSellerByEmail,
  createGoogleSeller,
  linkGoogleAccount,
  setSellerSession,
} from '../../../../lib/seller-auth.js';
import { safeRedirectPath } from '../../../../lib/safe-redirect.js';
import { googleClientId, googleClientSecret, googleRedirectUri } from '../../../../lib/google-oauth.js';

interface GoogleTokenResponse {
  access_token: string;
  error?: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  name: string;
  verified_email?: boolean;
}

export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam || !code || !state) {
    return redirect('/seller/login?error=oauth_denied');
  }

  const storedState = cookies.get('oauth_state')?.value;
  // Re-validated on the way out even though google.ts already sanitised it on the way in: this
  // is the line that actually emits the redirect, and a destination that reaches it unchecked is
  // exactly the bug. Cheap, and it stops the guarantee depending on a second file staying right.
  const nextPath = safeRedirectPath(cookies.get('oauth_next')?.value, '/seller/dashboard');

  cookies.delete('oauth_state', { path: '/' });
  cookies.delete('oauth_next', { path: '/' });

  if (!storedState || storedState !== state) {
    return redirect('/seller/login?error=oauth_invalid_state');
  }

  const clientId = googleClientId();
  const clientSecret = googleClientSecret();

  if (!clientId || !clientSecret) {
    return redirect('/seller/login?error=oauth_not_configured');
  }

  const redirectUri = googleRedirectUri(url.origin);

  // Exchange code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = (await tokenRes.json()) as GoogleTokenResponse;
    if (tokenData.error || !tokenData.access_token) {
      return redirect('/seller/login?error=oauth_token_failed');
    }
    accessToken = tokenData.access_token;
  } catch {
    return redirect('/seller/login?error=oauth_token_failed');
  }

  // Fetch user info
  let googleUser: GoogleUserInfo;
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    googleUser = (await userRes.json()) as GoogleUserInfo;
    if (!googleUser.id || !googleUser.email) {
      return redirect('/seller/login?error=oauth_user_failed');
    }
  } catch {
    return redirect('/seller/login?error=oauth_user_failed');
  }

  // Find or create account
  let seller = getSellerByGoogleId(googleUser.id);

  if (!seller) {
    const existing = getSellerByEmail(googleUser.email);
    if (existing) {
      // Email matches — link Google account to existing account
      linkGoogleAccount(existing.id, googleUser.id);
      seller = { ...existing, googleId: googleUser.id };
    } else {
      // New user — create account
      seller = createGoogleSeller(googleUser.email, googleUser.name, googleUser.id);
    }
  }

  setSellerSession(cookies, seller.id);
  return redirect(nextPath);
};
