export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlug, getOrderById, updateOrder } from '../../../lib/orders.js';
import type { StoreSubtotal } from '../../../lib/orders.js';

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

  let body: {
    orderId?: unknown; storeSlug?: unknown;
    shippingStatus?: unknown; trackingNumber?: unknown;
    buyerName?: unknown; buyerEmail?: unknown; buyerPhone?: unknown;
    buyerAddress?: unknown;
    itemDeletes?: unknown;
    shippingOverride?: unknown;
    discount?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { orderId, storeSlug, shippingStatus, trackingNumber, buyerName, buyerEmail, buyerPhone, buyerAddress, itemDeletes, shippingOverride, discount } = body;

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
  if (typeof buyerName === 'string' && buyerName.trim()) {
    updates['buyerName'] = buyerName.trim();
  }
  if (typeof buyerEmail === 'string' && buyerEmail.trim()) {
    updates['buyerEmail'] = buyerEmail.trim();
  }
  if (typeof buyerPhone === 'string') {
    updates['buyerPhone'] = buyerPhone.trim();
  }
  if (buyerAddress && typeof buyerAddress === 'object' && !Array.isArray(buyerAddress)) {
    const addr = buyerAddress as Record<string, unknown>;
    if (typeof addr['city'] === 'string' && typeof addr['street'] === 'string') {
      updates['buyerAddress'] = {
        city:   addr['city'].trim(),
        street: addr['street'].trim(),
        ...(typeof addr['zip'] === 'string' ? { zip: addr['zip'].trim() } : {}),
      };
    }
  }

  // Item deletes + shipping override + discount — all require recalculating subtotals
  const hasOrderEdit = (Array.isArray(itemDeletes) && itemDeletes.length > 0)
    || typeof shippingOverride === 'number'
    || (discount !== undefined && discount !== null);

  if (hasOrderEdit) {
    const original = getOrderById(orderId);
    if (!original) return json({ error: 'Order not found' }, 404);

    const deleteSet = new Set<string>(Array.isArray(itemDeletes) ? (itemDeletes as string[]).filter((x) => typeof x === 'string') : []);
    const newItems = original.items.filter((i) => !deleteSet.has(i.productId));

    const newSubtotals = { ...original.storeSubtotals };
    if (newSubtotals[storeSlug]) {
      const storeItems = newItems.filter((i) => i.storeSlug === storeSlug);
      const subtotal   = storeItems.reduce((s, i) => s + i.price * i.qty, 0);
      const shipping   = typeof shippingOverride === 'number' && shippingOverride >= 0
        ? shippingOverride
        : (newSubtotals[storeSlug]!.shipping);

      let discountEntry: StoreSubtotal['discount'] | undefined;
      if (discount && typeof discount === 'object' && !Array.isArray(discount)) {
        const d = discount as { type?: unknown; value?: unknown };
        const dtype = d.type === 'percent' || d.type === 'amount' ? d.type : undefined;
        const dval  = typeof d.value === 'number' && d.value >= 0 ? d.value : 0;
        if (dtype && dval > 0) {
          const base    = subtotal + shipping;
          const applied = dtype === 'percent' ? Math.min(base * dval / 100, base) : Math.min(dval, base);
          discountEntry = { type: dtype, value: dval, applied: Math.round(applied * 100) / 100 };
        }
      } else if (discount === null) {
        discountEntry = undefined;
      }

      newSubtotals[storeSlug] = { ...newSubtotals[storeSlug]!, subtotal, shipping, discount: discountEntry };
    }

    const totalAmount = Object.values(newSubtotals).reduce(
      (s, st) => s + st.subtotal + st.shipping - (st.discount?.applied ?? 0), 0
    );

    updates['items'] = newItems;
    updates['storeSubtotals'] = newSubtotals;
    updates['totalAmount'] = totalAmount;
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  const updated = updateOrder(orderId, updates as Parameters<typeof updateOrder>[1]);
  if (!updated) return json({ error: 'Order not found' }, 404);

  return json({ ok: true, order: updated });
}
