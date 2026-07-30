export const prerender = false;
import type { APIRoute } from 'astro';
import { safeRefererPath } from '../../lib/safe-redirect.js';

export const POST: APIRoute = ({ request, cookies }) => {
  const url = new URL(request.url);
  const lang = url.searchParams.get('l') === 'en' ? 'en' : 'he';
  cookies.set('lang', lang, { path: '/', maxAge: 60 * 60 * 24 * 365 });
  // "Back to the page you switched language on" — but only when that page is ours. Redirecting
  // to the raw Referer let any site POST here and have OUR origin bounce the visitor onward
  // (see lib/safe-redirect.ts); a foreign referrer now lands on the homepage instead.
  const back = safeRefererPath(request.headers.get('referer'), url.origin, '/');
  return new Response(null, { status: 303, headers: { Location: back } });
};
