export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId, updateStore, addStoreBgColor } from '../../lib/stores.js';
import { pingStoreChange } from '../../lib/indexnow.js';
import { parseStoreHoursForm } from '../../lib/store-hours.js';

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

    const bannerImage = String(form.get('bannerImage') ?? '').trim();
    const profileImage = String(form.get('profileImage') ?? '').trim();
    const address = String(form.get('address') ?? '').trim();
    const addressVisible = form.get('addressVisible') === 'on';
    const hoursVisible = form.get('hoursVisible') === 'on';
    const hours = parseStoreHoursForm(form);

    updateStore(target.id, {
      name, tagline, description, colors: target.colors, categories: categories.length ? categories : [],
      bannerImage: bannerImage || undefined, profileImage: profileImage || undefined,
      address: address || undefined, addressVisible, hours, hoursVisible,
    });
    // Store page content changed — notify the index (fire-and-forget, no-op in dev).
    pingStoreChange(target.slug);
    return json({ ok: true, name });
  }

  if (action === 'add-bg-color') {
    const storeId = String(form.get('storeId') || '');
    const color = String(form.get('color') || '').trim().toLowerCase();
    // Only a 6-digit hex is ever stored — never trust the client-sent value.
    if (!/^#[0-9a-f]{6}$/.test(color)) return json({ ok: false, error: 'Invalid color.' }, 400);
    const target = getStoresBySellerId(sellerId).find((s) => s.id === storeId);
    if (!target) return json({ ok: false, error: 'Store not found.' }, 404);
    const colors = addStoreBgColor(target.id, color);
    return json({ ok: true, colors });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
