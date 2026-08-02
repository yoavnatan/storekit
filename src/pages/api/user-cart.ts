export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, replaceUserCart, type UserCartData } from '../../lib/user-carts.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';

export async function GET({ cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response('Unauthorized', { status: 401 });
  return new Response(JSON.stringify(await getUserCart(sellerId)), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST({ cookies, request }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return new Response('Unauthorized', { status: 401 });
  const read = await readJsonBody<UserCartData>(request, BODY_LIMIT.collection);
  if (!read.ok) return new Response('Bad request', { status: read.status });
  try {
    const body = read.value;
    if (typeof body.cart !== 'object' || !Array.isArray(body.wishlist)) {
      return new Response('Bad request', { status: 400 });
    }
    if (body.recentStores !== undefined
        && (!Array.isArray(body.recentStores) || body.recentStores.some((s) => typeof s !== 'string'))) {
      return new Response('Bad request', { status: 400 });
    }
    // Saved stores are no longer part of this write at all — they are their own table, written
    // only by /api/favorite-store. The file version had to read them and hand them back on every
    // cart sync just to avoid erasing them.
    // recentStores: this device posts its own cookie list, and the module unions it (device-first
    // for recency) with whatever other devices recorded — inside the same transaction as the write,
    // so the read cannot be overtaken between the two. An absent list means "this device has
    // nothing to say", so the stored list is left alone.
    await replaceUserCart(sellerId, {
      cart: body.cart,
      wishlist: body.wishlist,
      ...(Array.isArray(body.recentStores) ? { recentStores: body.recentStores } : {}),
    });
    return new Response('ok');
  } catch {
    return new Response('Bad request', { status: 400 });
  }
}
