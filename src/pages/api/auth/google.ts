export const prerender = false;
import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { safeRedirectPath } from '../../../lib/safe-redirect.js';
import { googleClientId, googleRedirectUri } from '../../../lib/google-oauth.js';

export const GET: APIRoute = ({ redirect, cookies, url }) => {
  // Sanitised HERE, before it is stored — the callback redirects to this cookie's value, so a
  // hostile destination that got in would survive the whole OAuth round trip (lib/safe-redirect.ts).
  const safeNext = safeRedirectPath(url.searchParams.get('next'), '/seller/dashboard');

  const state = crypto.randomBytes(16).toString('hex');

  cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: 300,
  });
  cookies.set('oauth_next', safeNext, {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: 300,
  });

  const clientId = googleClientId();
  if (!clientId) {
    return new Response('Google OAuth not configured', { status: 503 });
  }

  const redirectUri = googleRedirectUri(url.origin);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};
