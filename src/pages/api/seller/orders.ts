export const prerender = false;
import type { APIContext } from 'astro';
import { getSellerSession, getSellerById } from '../../../lib/seller-auth.js';
import { findStoreBySlugOrPrevious, getStoresBySellerId } from '../../../lib/stores.js';
import { getOrdersByStoreSlug, getOrderById, updateOrder, orderStoreNotes, orderBelongsToStore } from '../../../lib/orders.js';
import { settleStoreClosure } from '../../../lib/store-lifecycle.js';
import { readJsonBody, BODY_LIMIT } from '../../../lib/request-body.js';
import { sendStoreLifecycleEmail } from '../../../lib/email/store-lifecycle-email.js';
import type { StoreSubtotal } from '../../../lib/orders.js';
import { notifyOrderStatusChanged } from '../../../lib/order-notify.js';
import { restockProduct } from '../../../lib/store-products.js';
import { filterAndSortSellerOrders, parseSellerOrderQuery } from '../../../lib/seller-orders-query.js';
import { paginate, parsePage } from '../../../lib/pagination.js';
import type { Order } from '../../../lib/orders.js';
import { orderNetForStore } from '../../../lib/admin-stats.js';
import { recordMoneyEvent } from '../../../lib/money-events.js';
import { storeSliceTotalAgorot } from '../../../lib/order-totals.js';
import { toAgorot } from '../../../lib/money.js';
import { SHIPPING_STATUS_RULES, canTransition, orderHoldsStock, type ShippingStatus } from '../../../lib/order-status-rules.js';
import { isValidEmail } from '../../../lib/email-address.js';

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

  const stores = await getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, reqSlug);
  if (!store) return json({ error: 'Store not found' }, 404);

  // Use the store's CURRENT slug for all order work — orders migrate to it on rename, and the client
  // may still send an old (cached) slug (resolved above). Keeps scoping correct across a URL change.
  const storeSlug = store.slug;
  const orders = await getOrdersByStoreSlug(storeSlug);

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

  const read = await readJsonBody<{
    orderId?: unknown; storeSlug?: unknown;
    shippingStatus?: unknown; trackingNumber?: unknown;
    buyerName?: unknown; buyerEmail?: unknown; buyerPhone?: unknown;
    buyerAddress?: unknown;
    itemDeletes?: unknown;
    shippingOverride?: unknown;
    discount?: unknown;
    sellerNotes?: unknown;
  }>(request, BODY_LIMIT.collection);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON' }, read.status);
  const body = read.value;

  const { orderId, storeSlug: reqSlug, shippingStatus, trackingNumber, buyerName, buyerEmail, buyerPhone, buyerAddress, itemDeletes, shippingOverride, discount, sellerNotes } = body;

  if (typeof orderId !== 'string' || typeof reqSlug !== 'string') {
    return json({ error: 'Missing orderId or storeSlug' }, 400);
  }

  const stores = await getStoresBySellerId(sellerId);
  const store = findStoreBySlugOrPrevious(stores, reqSlug);
  if (!store) return json({ error: 'Store not found' }, 404);
  // Current slug — orders migrate to it on rename; a client may still send an old (cached) slug.
  const storeSlug = store.slug;

  // The session proves which STORES this seller owns — never which orders, and an order id is
  // not a permission (lib/orders.ts#orderBelongsToStore). Bind the two before a single field is
  // read or written, otherwise a seller can cancel/restock/rewrite an order belonging to someone
  // else's store just by pairing its id with their own slug. 404, not 403: a caller with no claim
  // on this order learns nothing about whether it exists.
  // One read, reused below — nothing mutates the file before updateOrder() at the end.
  const existing = await getOrderById(orderId);
  if (!existing || !orderBelongsToStore(existing, storeSlug)) return json({ error: 'Order not found' }, 404);

  // Derived from the status table rather than re-listed here, so this endpoint can
  // never accept a status the rules don't describe (or reject one they do).
  const validStatuses = Object.keys(SHIPPING_STATUS_RULES);
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
    // Validated, not just trimmed: this field IS the buyer's notification address, so a typo saved
    // here silently stops every future order email to them. Reject rather than store it.
    const trimmed = buyerEmail.trim().toLowerCase();
    if (!isValidEmail(trimmed)) return json({ error: 'Invalid buyerEmail' }, 400);
    updates['buyerEmail'] = trimmed;
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
    const current = existing;
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
    const original = existing;

    const deleteSet = new Set<string>(Array.isArray(itemDeletes) ? (itemDeletes as string[]).filter((x) => typeof x === 'string') : []);
    const newItems = original.items.filter((i) => !deleteSet.has(i.productId));

    const newSubtotals = { ...original.storeSubtotals };
    if (newSubtotals[storeSlug]) {
      const storeItems = newItems.filter((i) => i.storeSlug === storeSlug);
      const subtotalAgorot = storeItems.reduce((sum, i) => sum + i.priceAgorot * i.qty, 0);
      // `shippingOverride` is a number the SELLER typed, so it arrives in ILS like every other
      // form field and converts here — the same edge every other input crosses.
      const shippingAgorot = typeof shippingOverride === 'number' && shippingOverride >= 0
        ? toAgorot(shippingOverride)
        : (newSubtotals[storeSlug]!.shippingAgorot);

      let discountEntry: StoreSubtotal['discount'] | undefined;
      if (discount && typeof discount === 'object' && !Array.isArray(discount)) {
        const d = discount as { type?: unknown; value?: unknown };
        const dtype = d.type === 'percent' || d.type === 'amount' ? d.type : undefined;
        // A percent is ROUNDED to whole points, which it was not before. `discount_percent` is an
        // `integer` column, so 12.5 would have been stored as 12 without a word while `applied`
        // stayed computed from 12.5 — and the seller's next edit of that order would recompute a
        // different total off the rounded value, silently. This is the same rule every other
        // discount input in the app already applies (discount-input.ts#clampDiscountValue).
        const dvalRaw = typeof d.value === 'number' && d.value >= 0 ? d.value : 0;
        const dval  = dtype === 'percent' ? Math.round(dvalRaw) : dvalRaw;
        if (dtype && dval > 0) {
          // Discounted against the SUBTOTAL, never subtotal + shipping. Two reasons,
          // and the second one was a live bug:
          //   1. Shipping is the platform's rate, not the seller's margin
          //      (AI_INSTRUCTIONS.md → shipping model) — a seller giving away goods
          //      must not be giving away the carrier's fee too.
          //   2. Revenue is read as `subtotal − discount` (admin-stats.ts
          //      #orderNetForStore), which excludes shipping. Discounting against a
          //      base that INCLUDED shipping meant a 100% discount produced
          //      `subtotal − (subtotal + shipping)` = NEGATIVE revenue for that
          //      store, dragging the seller's chart, the platform GMV and the
          //      commission split below zero. Found by tests/reporting-fuzz.test.ts.
          const base    = subtotalAgorot;
          // Both branches land on an integer number of agorot: a percentage of an integer is
          // rounded once, here, and a ₪-off value converts from what the seller typed.
          const applied = dtype === 'percent'
            ? Math.min(Math.round((base * dval) / 100), base)
            : Math.min(toAgorot(dval), base);
          discountEntry = { type: dtype, value: dval, appliedAgorot: applied };
        }
      } else if (discount === null) {
        // An explicit clear.
        discountEntry = undefined;
      } else {
        // Not mentioned in this request at all — keep the store's existing discount rather
        // than dropping it. Silently wiping money the seller never touched is exactly what
        // a partial update must not do, and the caller may legitimately be sending only the
        // fields it changed (a second tab editing the same order — see the modal's payload).
        // Re-applied against the new base, since items or shipping may have just moved.
        const existing = newSubtotals[storeSlug]!.discount;
        if (existing) {
          // Same base as the branch above — see its comment.
          const base = subtotalAgorot;
          const applied = existing.type === 'percent'
            ? Math.min(Math.round((base * existing.value) / 100), base)
            : Math.min(toAgorot(existing.value), base);
          discountEntry = { ...existing, appliedAgorot: applied };
        }
      }

      newSubtotals[storeSlug] = { ...newSubtotals[storeSlug]!, subtotalAgorot, shippingAgorot, discount: discountEntry };
    }

    // The same definition the seller's own card renders (order-totals.ts) — so the total this
    // save writes and the total the card shows cannot be two different sums.
    const totalAgorot = Object.values(newSubtotals).reduce((sum, st) => sum + storeSliceTotalAgorot(st), 0);

    updates['items'] = newItems;
    updates['storeSubtotals'] = newSubtotals;
    updates['totalAgorot'] = totalAgorot;
  }

  if (Object.keys(updates).length === 0) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  // Capture the pre-change status so the automation layer can tell whether the
  // shipping status actually moved (read only when a status change is in play).
  const changingStatus = typeof updates['shippingStatus'] === 'string';
  const before = existing;
  const prevStatus = changingStatus ? before.shippingStatus : '';
  const prevNet = orderNetForStore(before, storeSlug);

  if (changingStatus && prevStatus) {
    // Both transition rules come from the status table (lib/order-status-rules.ts):
    // 'cancelled' is terminal because the stock is already back on the shelf, and a
    // cancellation is only valid before the parcel is moving. Asking the table means
    // a future status inherits the right answer instead of needing another `if` here.
    const verdict = canTransition(prevStatus as ShippingStatus, updates['shippingStatus'] as ShippingStatus);
    if (!verdict.ok) return json({ error: verdict.reason }, 409);
  }

  const updated = await updateOrder(orderId, updates as Parameters<typeof updateOrder>[1]);
  if (!updated) return json({ error: 'Order not found' }, 404);

  // Journal every money-relevant mutation before acting on it (lib/money-events.ts).
  // A status move is a money event even though no amount changes hands: 'cancelled'
  // is what takes an order OUT of every revenue sum while leaving paymentStatus at
  // 'paid', so without this entry there is no record of why a seller's reported
  // revenue dropped between two views of the same period.
  if (prevStatus && updated.shippingStatus !== prevStatus) {
    await recordMoneyEvent({
      type: 'shipping_status_changed',
      orderId,
      checkoutRef: updated.checkoutRef,
      storeSlug,
      amountAgorot: orderNetForStore(updated, storeSlug),
      from: prevStatus,
      to: updated.shippingStatus,
      actor: sellerId,
      detail: !orderHoldsStock(updated)
        ? 'cancelled — items restocked, order leaves every revenue sum (countsAsRevenue)'
        : undefined,
    });
  }
  const newNet = orderNetForStore(updated, storeSlug);
  if (newNet !== prevNet) {
    await recordMoneyEvent({
      type: 'order_discount_changed',
      orderId,
      checkoutRef: updated.checkoutRef,
      storeSlug,
      amountAgorot: newNet,
      from: String(prevNet),
      to: String(newNet),
      actor: sellerId,
      detail: 'seller edited items / shipping / discount on this order',
    });
  }

  if (prevStatus && updated.shippingStatus !== prevStatus) {
    // Stock goes back when the order stops holding it — asked of the status table
    // (holdsStock) rather than tested against 'cancelled', so a future "returned"
    // or "refunded" status restocks by filling in a row instead of by someone
    // remembering this line exists. Each order is single-store (checkout creates one
    // per store), so all items belong to this seller — safe to restock the lot.
    // Guarded by the prev!==new check above, so a repeat request can't double-restock.
    if (orderHoldsStock({ shippingStatus: prevStatus as ShippingStatus }) && !orderHoldsStock(updated)) {
      for (const item of updated.items) {
        await restockProduct(item.productId, item.qty, item.selectedVariants);
      }
    }
    // Source-agnostic status pipeline: whoever moved the status (seller today,
    // carrier webhook later), the buyer gets told. No-op if no buyer account —
    // see order-notify.ts.
    await notifyOrderStatusChanged(updated, prevStatus, { storeName: store.name, storeSlug: store.slug });
    // A seller who asked to close the store while orders were still open gets that closure
    // completed HERE, the moment the last one stops being an open obligation — rather than
    // having to come back and press the button a second time (store-lifecycle.ts). No-op unless
    // a closure is actually pending and actually unblocked, so it costs one status read on a
    // status change and nothing at all otherwise.
    const justClosed = await settleStoreClosure(store.slug);
    // The one state change in this whole feature the seller did NOT just click a button for — it
    // happened because they finished an order. Without this mail the store would close silently
    // and they would find out by visiting it. Not awaited; it never throws.
    if (justClosed) {
      const seller = await getSellerById(store.sellerId);
      if (seller) {
        void sendStoreLifecycleEmail({
          to: seller.email,
          sellerName: seller.name,
          store: justClosed,
          state: 'closed',
          openOrders: 0,
        });
      }
    }
  }

  return json({ ok: true, order: scopeOrder(updated, storeSlug) });
}
