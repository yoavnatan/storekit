export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId, updateStore } from '../../lib/stores.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const form = await request.formData();
  const action = String(form.get('_action') || '');

  if (action === 'save-settings') {
    const storeId = String(form.get('storeId') || '');
    const stores = getStoresBySellerId(sellerId);
    const target = stores.find((s) => s.id === storeId) ?? stores[0];
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);

    const name = String(form.get('name') || '').trim();
    const tagline = String(form.get('tagline') || '').trim();
    const description = String(form.get('description') || '').trim();
    const categoriesRaw = String(form.get('categories') ?? '');
    const categories = categoriesRaw.split(',').map(c => c.trim()).filter(Boolean);

    if (!name) return json({ ok: false, error: 'Store name is required.' }, 400);

    updateStore(target.id, { name, tagline, description, colors: target.colors, categories: categories.length ? categories : [] });
    return json({ ok: true, name });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
