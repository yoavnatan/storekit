export const prerender = false;
import type { APIContext } from 'astro';
import { requireAdmin } from '../../../lib/admin-auth.js';
import { getStoreBySlug } from '../../../lib/stores.js';
import { getProductsByStoreId } from '../../../lib/store-products.js';
import { paginate, parsePage } from '../../../lib/pagination.js';
import { thumbUrl } from '../../../lib/cloudinary.js';

// Admin-facing per-store product list for the Stores tab's on-demand block
// list (see AdminStoresPanel.astro + stores.ts). Server-side searched +
// paginated so a store with 1000 products never floods the panel or the wire —
// only one small page's rows cross the network at a time, and search runs over
// the full catalog server-side (not a DOM filter). Read-only reporting; the
// actual block toggle still goes through /api/admin/moderation. Admin cookie is
// the only gate — the admin owns no store, so the slug is the key (mirrors
// /api/admin/performance).

const PAGE_SIZE = 8;

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const denied = requireAdmin(cookies);
  if (denied) return denied;

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  if (!storeSlug) return json({ error: 'Missing storeSlug' }, 400);

  const store = await getStoreBySlug(storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  let products = await getProductsByStoreId(store.id);
  if (q) {
    products = products.filter((p) =>
      p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q));
  }

  const pageResult = paginate(products, parsePage(url.searchParams, 'page'), PAGE_SIZE);
  const items = pageResult.items.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    blocked: !!p.blocked,
    image: p.images?.[0] ? thumbUrl(p.images[0], 72, 72) : null,
  }));
  return json({
    ok: true,
    products: items,
    page: pageResult.page,
    totalPages: pageResult.totalPages,
    total: pageResult.total,
  });
}
