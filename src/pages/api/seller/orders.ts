export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlug, updateOrder } from '../../../lib/orders.js';

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function GET({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const storeSlug = url.searchParams.get('storeSlug');
  if (!storeSlug) return json({ error: 'Missing storeSlug' }, 400);

  const stores = getStoresBySellerId(sellerId);
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const orders = getOrdersByStoreSlug(storeSlug);
  return json({ orders });
}

export async function PATCH({ request, cookies }: APIContext): Promise<Response> {
  const sellerId = getSellerSession(cookies);
  if (!sellerId) return json({ error: 'Unauthorized' }, 401);

  let body: { orderId?: unknown; storeSlug?: unknown; shippingStatus?: unknown; trackingNumber?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { orderId, storeSlug, shippingStatus, trackingNumber } = body;

  if (typeof orderId !== 'string' || typeof storeSlug !== 'string') {
    return json({ error: 'Missing orderId or storeSlug' }, 400);
  }

  const stores = getStoresBySellerId(sellerId);
  const store = stores.find((s) => s.slug === storeSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  const validStatuses = ['pending', 'processing', 'ready', 'shipped', 'delivered'];
  const updates: Record<string, unknown> = {};

  if (typeof shippingStatus === 'string' && validStatuses.includes(shippingStatus)) {
    updates['shippingStatus'] = shippingStatus;
  }
  if (typeof trackingNumber === 'string') {
    updates['trackingNumber'] = trackingNumber;
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  const updated = updateOrder(orderId, updates as Parameters<typeof updateOrder>[1]);
  if (!updated) return json({ error: 'Order not found' }, 404);

  return json({ ok: true, order: updated });
}
