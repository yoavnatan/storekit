export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, saveUserCart } from '../../lib/user-carts.js';
import { getFavoriteStoreCount } from '../../lib/store-favorite-counts.js';
import { getStoreBySlug } from '../../lib/stores.js';

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

  if (!getStoreBySlug(storeSlug)) {
    return new Response('Store not found', { status: 404 });
  }

  const userData = getUserCart(userId);
  const favorites = userData.favoriteStores ?? [];
  const idx = favorites.indexOf(storeSlug);
  const favorited = idx === -1;

  if (favorited) {
    favorites.push(storeSlug);
  } else {
    favorites.splice(idx, 1);
  }

  saveUserCart(userId, { ...userData, favoriteStores: favorites });

  return new Response(
    JSON.stringify({ favorited, count: getFavoriteStoreCount(storeSlug) }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
