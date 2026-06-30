export const prerender = false;
import type { APIRoute } from 'astro';
import crypto from 'node:crypto';

export const GET: APIRoute = ({ redirect, cookies, url }) => {
  const rawNext = url.searchParams.get('next') ?? '';
  const safeNext =
    rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/seller/dashboard';

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

  const clientId = import.meta.env.GOOGLE_CLIENT_ID as string | undefined;
  if (!clientId) {
    return new Response('Google OAuth not configured', { status: 503 });
  }

  const redirectUri =
    (import.meta.env.GOOGLE_REDIRECT_URI as string | undefined) ||
    `${url.origin}/api/auth/google/callback`;

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
