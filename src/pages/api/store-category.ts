export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../lib/stores.js';
import { createCategory, renameCategory, deleteCategory, moveCategory, getCategoryById, buildCategoryTree, getCategoriesByStoreId } from '../../lib/store-categories.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ownsStore(sellerId: string, storeId: string): boolean {
  return getStoresBySellerId(sellerId).some((s) => s.id === storeId);
}

function ownsCategory(sellerId: string, categoryId: string): boolean {
  const category = getCategoryById(categoryId);
  return !!category && ownsStore(sellerId, category.storeId);
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const form = await request.formData();
  const action = String(form.get('_action') || '');

  if (action === 'create-category') {
    const storeId = String(form.get('storeId') || '');
    if (!ownsStore(sellerId, storeId)) return json({ ok: false, error: 'Not authorized' }, 403);
    const name = String(form.get('name') || '');
    const parentIdRaw = String(form.get('parentId') || '');
    if (parentIdRaw && !ownsCategory(sellerId, parentIdRaw)) return json({ ok: false, error: 'Not authorized' }, 403);

    const result = createCategory(storeId, { name, parentId: parentIdRaw || null });
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, tree: buildCategoryTree(getCategoriesByStoreId(storeId)) });
  }

  if (action === 'rename-category') {
    const categoryId = String(form.get('categoryId') || '');
    if (!ownsCategory(sellerId, categoryId)) return json({ ok: false, error: 'Not authorized' }, 403);
    const name = String(form.get('name') || '');

    const result = renameCategory(categoryId, name);
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, tree: buildCategoryTree(getCategoriesByStoreId(result.storeId)) });
  }

  if (action === 'delete-category') {
    const categoryId = String(form.get('categoryId') || '');
    const category = getCategoryById(categoryId);
    if (!category || !ownsStore(sellerId, category.storeId)) return json({ ok: false, error: 'Not authorized' }, 403);

    const result = deleteCategory(categoryId);
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, tree: buildCategoryTree(getCategoriesByStoreId(category.storeId)) });
  }

  if (action === 'move-category') {
    const categoryId = String(form.get('categoryId') || '');
    const category = getCategoryById(categoryId);
    if (!category || !ownsStore(sellerId, category.storeId)) return json({ ok: false, error: 'Not authorized' }, 403);
    const direction = form.get('direction') === 'down' ? 'down' : 'up';

    const result = moveCategory(categoryId, direction);
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, tree: buildCategoryTree(getCategoriesByStoreId(category.storeId)) });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
