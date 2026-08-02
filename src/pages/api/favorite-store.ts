export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, saveUserCart } from '../../lib/user-carts.js';
import { getFavoriteStoreCount } from '../../lib/store-favorite-counts.js';
import { getStoreBySlugOrPrevious } from '../../lib/stores.js';

export async function POST({ cookies, request }: APIContext): Promise<Response> {
  const userId = getSellerSession(cookies);
  if (!userId) return new Response('Unauthorized', { status: 401 });

  let storeSlug: string;
  try {
    const body = await request.json() as { storeSlug?: unknown };
    if (typeof body.storeSlug !== 'string' || !body.storeSlug) {
      return new Response('Bad request', { status: 400 });
    }
    storeSlug = body.storeSlug;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  // Tolerate a previous slug (store URL renamed since the page loaded) and always store the CURRENT
  // slug — favorites are migrated to the current slug on rename, so this keeps toggles consistent.
  const store = await getStoreBySlugOrPrevious(storeSlug);
  if (!store) {
    return new Response('Store not found', { status: 404 });
  }

  const userData = getUserCart(userId);
  const favorites = userData.favoriteStores ?? [];
  const idx = favorites.indexOf(store.slug);
  const favorited = idx === -1;

  if (favorited) {
    favorites.push(store.slug);
  } else {
    favorites.splice(idx, 1);
  }

  saveUserCart(userId, { ...userData, favoriteStores: favorites });

  return new Response(
    JSON.stringify({ favorited, count: getFavoriteStoreCount(storeSlug) }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
