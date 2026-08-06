export const prerender = false;
import type { APIRoute } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { ownedStore } from '../../lib/store-ownership.js';
import { createCategory, renameCategory, deleteCategory, moveCategory, getCategoryById, buildCategoryTree, getCategoriesByStoreId } from '../../lib/store-categories.js';
import { findSpamKeyword, spamRejectionMessage, findKeywordStuffing, stuffingRejectionMessage } from '../../lib/spam-filter.js';
import { refreshStoreSaleScope } from '../../lib/store-sale-scope.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function ownsStore(sellerId: string, storeId: string): Promise<boolean> {
  return !!(await ownedStore(sellerId, storeId));
}

async function ownsCategory(sellerId: string, categoryId: string): Promise<boolean> {
  const category = await getCategoryById(categoryId);
  return !!category && await ownsStore(sellerId, category.storeId);
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ ok: false, error: 'Not authenticated' }, 401);

  const form = await request.formData();
  const action = String(form.get('_action') || '');

  if (action === 'create-category') {
    const storeId = String(form.get('storeId') || '');
    if (!await ownsStore(sellerId, storeId)) return json({ ok: false, error: 'Not authorized' }, 403);
    const name = String(form.get('name') || '');
    const parentIdRaw = String(form.get('parentId') || '');
    if (parentIdRaw && !await ownsCategory(sellerId, parentIdRaw)) return json({ ok: false, error: 'Not authorized' }, 403);
    const spamHit = findSpamKeyword(name);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    const result = await createCategory(storeId, { name, parentId: parentIdRaw || null });
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    // The tree just changed, so a category-scoped sale's flattened scope may be stale (a new
    // subcategory belongs inside it; a deleted one no longer exists). Re-resolve before the
    // storefront reads it — see store-sale-scope.ts for why the list is stored, not computed.
    await refreshStoreSaleScope(storeId);
    return json({ ok: true, tree: buildCategoryTree(await getCategoriesByStoreId(storeId)) });
  }

  if (action === 'rename-category') {
    const categoryId = String(form.get('categoryId') || '');
    if (!await ownsCategory(sellerId, categoryId)) return json({ ok: false, error: 'Not authorized' }, 403);
    const name = String(form.get('name') || '');
    const spamHit = findSpamKeyword(name);
    if (spamHit) return json({ ok: false, error: spamRejectionMessage(spamHit) }, 400);
    const stuffingHit = findKeywordStuffing(name);
    if (stuffingHit) return json({ ok: false, error: stuffingRejectionMessage(stuffingHit) }, 400);

    const result = await renameCategory(categoryId, name);
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, tree: buildCategoryTree(await getCategoriesByStoreId(result.storeId)) });
  }

  if (action === 'delete-category') {
    const categoryId = String(form.get('categoryId') || '');
    const category = await getCategoryById(categoryId);
    if (!category || !await ownsStore(sellerId, category.storeId)) return json({ ok: false, error: 'Not authorized' }, 403);

    const result = await deleteCategory(categoryId);
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    // The tree just changed, so a category-scoped sale's flattened scope may be stale (a new
    // subcategory belongs inside it; a deleted one no longer exists). Re-resolve before the
    // storefront reads it — see store-sale-scope.ts for why the list is stored, not computed.
    await refreshStoreSaleScope(category.storeId);
    return json({ ok: true, tree: buildCategoryTree(await getCategoriesByStoreId(category.storeId)) });
  }

  if (action === 'move-category') {
    const categoryId = String(form.get('categoryId') || '');
    const category = await getCategoryById(categoryId);
    if (!category || !await ownsStore(sellerId, category.storeId)) return json({ ok: false, error: 'Not authorized' }, 403);
    const direction = form.get('direction') === 'down' ? 'down' : 'up';

    const result = await moveCategory(categoryId, direction);
    if ('error' in result) return json({ ok: false, error: result.error }, 400);
    return json({ ok: true, tree: buildCategoryTree(await getCategoriesByStoreId(category.storeId)) });
  }

  return json({ ok: false, error: 'Unknown action.' }, 400);
};
