import type { APIRoute } from 'astro';
import { adjustWishlistCount } from '../../lib/wishlist-counts.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const read = await readJsonBody(request, BODY_LIMIT.control);
  if (!read.ok) {
    return new Response(JSON.stringify({ ok: false, error: read.status === 413 ? 'Body too large' : 'Bad JSON' }), {
      status: read.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const body = read.value;

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
