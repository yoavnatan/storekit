export const prerender = false;
import type { APIRoute } from 'astro';
import { searchSite } from '../../lib/site-search.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Platform-wide search for the mall/homepage search bar — stores + products
// together, so a product hit can show which store it belongs to.
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q') ?? '';
  const { stores, products } = searchSite(q);
  return json({ ok: true, stores, products });
};
