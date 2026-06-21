export const prerender = false;
import type { APIRoute } from 'astro';

export const POST: APIRoute = ({ request, cookies }) => {
  const url = new URL(request.url);
  const lang = url.searchParams.get('l') === 'en' ? 'en' : 'he';
  cookies.set('lang', lang, { path: '/', maxAge: 60 * 60 * 24 * 365 });
  const referer = request.headers.get('referer') ?? '/';
  return new Response(null, { status: 303, headers: { Location: referer } });
};
