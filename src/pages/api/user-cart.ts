export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, saveUserCart, type UserCartData } from '../../lib/user-carts.js';

export async function GET({ cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response('Unauthorized', { status: 401 });
  return new Response(JSON.stringify(getUserCart(sellerId)), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST({ cookies, request }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response('Unauthorized', { status: 401 });
  try {
    const body = await request.json() as UserCartData;
    if (typeof body.cart !== 'object' || !Array.isArray(body.wishlist)) {
      return new Response('Bad request', { status: 400 });
    }
    // Preserve favoriteStores — they're managed by /api/favorite-store, never by cart-sync
    const existing = getUserCart(sellerId);
    saveUserCart(sellerId, { ...body, favoriteStores: existing.favoriteStores ?? [] });
    return new Response('ok');
  } catch {
    return new Response('Bad request', { status: 400 });
  }
}
