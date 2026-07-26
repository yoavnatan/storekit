export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession } from '../../../lib/seller-auth.js';
import { findStoreBySlugOrPrevious, getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlug, getOrderById, updateOrder, orderStoreNotes } from '../../../lib/orders.js';
import type { StoreSubtotal } from '../../../lib/orders.js';
import { notifyOrderStatusChanged } from '../../../lib/order-notify.js';
import { restockProduct } from '../../../lib/store-products.js';
import { filterAndSortSellerOrders, parseSellerOrderQuery } from '../../../lib/seller-orders-query.js';
import { paginate, parsePage } from '../../../lib/pagination.js';
import type { Order } from '../../../lib/orders.js';

// Never ship the whole per-store sellerNotes map to the client — on a multi-store
// order that would expose another store's seller's private notes. Replace it with
// just THIS store's own list, scoped as a `notes` array.
function scopeOrder(o: Order, storeSlug: string): Omit<Order, 'sellerNotes'> & { notes: string[] } {
  const { sellerNotes, ...rest } = o;
  return { ...rest, notes: orderStoreNotes(o, storeSlug) };
}

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
  const reqSlug = url.searchParams.get('storeSlug');
  if (!reqSlug) return json({ error: 'Missing storeSlug' }, 400);

  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, reqSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Use the store's CURRENT slug for all order work — orders migrate to it on rename, and the client
  // may still send an old (cached) slug (resolved above). Keeps scoping correct across a URL change.
  const storeSlug = store.slug;
  const orders = getOrdersByStoreSlug(storeSlug);

  // No ?page → the original unfiltered/unpaginated shape, used by the
  // 15s new-order poll (it needs to see every order regardless of the
  // seller's current page/filter/search to reliably detect brand-new ones).
  if (!url.searchParams.has('page')) return json({ orders: orders.map((o) => scopeOrder(o, storeSlug)) });

  const query = parseSellerOrderQuery(url.searchParams);
  const filtered = filterAndSortSellerOrders(orders, storeSlug, query);
  const page = paginate(filtered, parsePage(url.searchParams, 'page'), 15);
  return json({ ok: true, items: page.items.map((o) => scopeOrder(o, storeSlug)), page: page.page, totalPages: page.totalPages, total: page.total });
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
    sellerNotes?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { orderId, storeSlug: reqSlug, shippingStatus, trackingNumber, buyerName, buyerEmail, buyerPhone, buyerAddress, itemDeletes, shippingOverride, discount, sellerNotes } = body;

  if (typeof orderId !== 'string' || typeof reqSlug !== 'string') {
    return json({ error: 'Missing orderId or storeSlug' }, 400);
  }

  const stores = getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, reqSlug);
  if (!store) return json({ error: 'Store not found' }, 404);
  // Current slug — orders migrate to it on rename; a client may still send an old (cached) slug.
  const storeSlug = store.slug;

  const validStatuses = ['pending', 'processing', 'ready', 'shipped', 'delivered', 'cancelled'];
  // A cancellation may only happen before the parcel is on its way — restocking
  // an order that's already shipped/delivered would inflate inventory.
  const CANCELLABLE_FROM = ['pending', 'processing', 'ready'];
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
  // Private seller-only notes (a LIST), scoped under this store's slug so they never
  // touch another store's notes on a shared multi-store order. The client sends the
  // full replacement list for this store; an empty list clears just this store's key.
  // Each note trimmed + capped like the product note; the list itself is bounded.
  if (Array.isArray(sellerNotes)) {
    const current = getOrderById(orderId);
    if (!current) return json({ error: 'Order not found' }, 404);
    const cleaned = (sellerNotes as unknown[])
      .map((n) => (typeof n === 'string' ? n.trim().slice(0, 2000) : ''))
      .filter((n) => n !== '')
      .slice(0, 50);
    const notes = { ...(current.sellerNotes ?? {}) } as Record<string, string[]>;
    if (cleaned.length) notes[storeSlug] = cleaned; else delete notes[storeSlug];
    updates['sellerNotes'] = notes;
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

  // Capture the pre-change status so the automation layer can tell whether the
  // shipping status actually moved (read only when a status change is in play).
  const changingStatus = typeof updates['shippingStatus'] === 'string';
  const prevStatus = changingStatus ? (getOrderById(orderId)?.shippingStatus ?? '') : '';

  if (changingStatus && prevStatus) {
    // 'cancelled' is terminal — no status change out of it (the stock has been
    // returned; re-activating would ship an order whose units are gone).
    if (prevStatus === 'cancelled' && updates['shippingStatus'] !== 'cancelled') {
      return json({ error: 'Order is cancelled and cannot change status' }, 409);
    }
    // A cancellation is only valid before the parcel is on its way.
    if (updates['shippingStatus'] === 'cancelled' && !CANCELLABLE_FROM.includes(prevStatus)) {
      return json({ error: 'Order can no longer be cancelled' }, 409);
    }
  }

  const updated = updateOrder(orderId, updates as Parameters<typeof updateOrder>[1]);
  if (!updated) return json({ error: 'Order not found' }, 404);

  if (prevStatus && updated.shippingStatus !== prevStatus) {
    // Cancelling returns every reserved unit to stock. Each order is single-store
    // (checkout creates one order per store), so all items belong to this seller —
    // safe to restock the lot. Guarded by the prev!==new check above, so a repeat
    // request can't double-restock.
    if (updated.shippingStatus === 'cancelled') {
      for (const item of updated.items) {
        await restockProduct(item.productId, item.qty, item.selectedVariants);
      }
    }
    // Source-agnostic status pipeline: whoever moved the status (seller today,
    // carrier webhook later), the buyer gets told. No-op if no buyer account —
    // see order-notify.ts.
    notifyOrderStatusChanged(updated, prevStatus, { storeName: store.name, storeSlug: store.slug });
  }

  return json({ ok: true, order: scopeOrder(updated, storeSlug) });
}
