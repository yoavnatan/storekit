import type { APIRoute } from 'astro';
import { adjustWishlistCount } from '../../lib/wishlist-counts.js';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Bad JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { action, productSlug } = body as { action?: string; productSlug?: string };

  if ((action !== 'add' && action !== 'remove') || !productSlug || typeof productSlug !== 'string') {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid params' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  adjustWishlistCount(productSlug, action === 'add' ? 1 : -1);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
