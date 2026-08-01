import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DeliveryMethod } from './shipping.js';
import { orderCountsAsRevenue } from './order-status-rules.js';

const ORDERS_PATH = path.join(process.cwd(), 'data/orders.json');

export interface OrderItem {
  productId: string;
  productName: string;
  productSlug: string;
  storeSlug: string;
  storeName: string;
  price: number;
  qty: number;
  image?: string;
  selectedVariants?: Record<string, string>;
}

export interface StoreSubtotal {
  storeName: string;
  subtotal: number;
  shipping: number;
  /** Delivery method the buyer chose for this store — so the seller knows to prepare it
   *  for pickup vs ship it. Set from the validated method at checkout. Optional for
   *  backward-compat with orders placed before delivery methods existed. */
  deliveryMethod?: DeliveryMethod;
  discount?: { type: 'percent' | 'amount'; value: number; applied: number };
}

export interface Order {
  id: string;
  checkoutRef?: string;
  buyerId?: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  buyerAddress: {
    city: string;
    street: string;
    zip?: string;
  };
  items: OrderItem[];
  storeSubtotals: Record<string, StoreSubtotal>;
  shippingAmount: number;
  totalAmount: number;
  paymentRef?: string;
  paymentStatus: 'pending' | 'paid' | 'failed';
  shippingStatus: 'pending' | 'processing' | 'ready' | 'shipped' | 'delivered' | 'cancelled';
  trackingNumber?: string;
  /** Private seller-only handling notes, keyed by storeSlug so each seller's notes on a
   *  (possibly multi-store) order stay private from the other stores' sellers. A LIST per
   *  store (a seller can jot several notes). Never exposed to the buyer or leaked
   *  cross-store: /api/seller/orders returns only the requesting store's own list as a
   *  scoped `notes` array, never this whole map. Legacy data may hold a single string per
   *  store — read it through orderStoreNotes(), which coerces string → one-item list. */
  sellerNotes?: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

/** This store's private notes on an order as a list, coercing legacy single-string data. */
/**
 * Does this order count toward money actually earned?
 *
 * THE one predicate for revenue/GMV — seller performance and the admin platform
 * stats both go through it, because they drifted apart exactly once and the
 * result was money reported that no longer existed.
 *
 * `paymentStatus === 'paid'` alone is not the question. A cancellation
 * deliberately leaves `paymentStatus` at 'paid' (the charge really did happen;
 * the refund is a separate event) and moves `shippingStatus` to 'cancelled',
 * restocking the items. So a cancelled order stayed inside every revenue sum:
 * the seller's Performance tab and the admin's GMV/commission split would both
 * keep reporting a sale whose stock had already gone back on the shelf. Nobody
 * had cancelled a paid order yet in the data, which is the only reason it hadn't
 * surfaced — it was waiting for the first real one.
 *
 * If a partial-refund state is ever added, it belongs here too, not at a call site.
 *
 * The rule itself now lives in order-status-rules.ts, as one row per status in a
 * table with a column per consequence — so a new status cannot be added without
 * answering "does this count as revenue?" alongside every other question it raises.
 * This stays the name the rest of the codebase calls.
 */
export function countsAsRevenue(o: Pick<Order, 'paymentStatus' | 'shippingStatus'>): boolean {
  return orderCountsAsRevenue(o);
}

export function orderStoreNotes(o: Order, storeSlug: string): string[] {
  const v = o.sellerNotes?.[storeSlug] as unknown;
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  if (typeof v === 'string' && v.trim() !== '') return [v];
  return [];
}

export type CreateOrderInput = Omit<Order, 'id' | 'shippingStatus' | 'createdAt' | 'updatedAt'>;

function readOrders(): Order[] {
  try { return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8')) as Order[]; }
  catch { return []; }
}

function writeOrders(orders: Order[]): void {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

export function createOrder(input: CreateOrderInput): Order {
  const orders = readOrders();
  const now = new Date().toISOString();
  const order: Order = {
    ...input,
    id: crypto.randomUUID(),
    // paymentStatus comes from the caller — checkout sets it from the PaymentProvider
    // result, so the order records the actual charge outcome rather than assuming it.
    // When a real webhook-based confirm step lands, that becomes the place it flips paid.
    shippingStatus: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  orders.push(order);
  writeOrders(orders);
  return order;
}

export function getOrderById(id: string): Order | null {
  return readOrders().find((o) => o.id === id) ?? null;
}

export function getAllOrders(): Order[] {
  return readOrders();
}

/** Is this order one of `storeSlug`'s to see and to manage?
 *
 *  **Every by-id order mutation must go through this.** A seller session proves which STORES the
 *  seller owns — it says nothing about which ORDERS, and an order id is not a permission. Without
 *  this bind, `PATCH /api/seller/orders` accepted any orderId as long as the *slug* alongside it was
 *  the caller's own, which let one seller move another seller's order to 'cancelled' (restocking
 *  that seller's inventory and mailing their buyer), rewrite the buyer's name/address, or delete
 *  items and recompute the total. Fixed 2026-08-02; `tests/seller-orders-scope.test.ts` keeps it.
 *
 *  The `storeSubtotals` key is checked as well as the items: a seller who deletes the last item of
 *  their own order must not lock themselves out of it — the subtotal key survives that edit. */
export function orderBelongsToStore(order: Pick<Order, 'items' | 'storeSubtotals'>, storeSlug: string): boolean {
  if (!storeSlug) return false;
  return order.items.some((i) => i.storeSlug === storeSlug)
    || (order.storeSubtotals ?? {})[storeSlug] !== undefined;
}

export function getOrdersByStoreSlug(storeSlug: string): Order[] {
  return readOrders()
    .filter((o) => orderBelongsToStore(o, storeSlug))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Repoint the denormalized storeSlug on every order (item-level + the storeSubtotals key) from
 *  oldSlug→newSlug when a store's URL is renamed. Without this a seller LOSES all pre-rename orders
 *  from their dashboard/revenue (getOrdersByStoreSlug matches by slug) and buyer order-history links
 *  would need a 301. Historical prices/names/quantities are untouched — only the URL identifier. */
export function renameStoreSlugInOrders(oldSlug: string, newSlug: string): void {
  if (!oldSlug || oldSlug === newSlug) return;
  const orders = readOrders();
  let changed = false;
  for (const o of orders) {
    for (const it of o.items) {
      if (it.storeSlug === oldSlug) { it.storeSlug = newSlug; changed = true; }
    }
    if (o.storeSubtotals?.[oldSlug]) {
      o.storeSubtotals[newSlug] = o.storeSubtotals[oldSlug]!; // a single order never has one store under two slugs
      delete o.storeSubtotals[oldSlug];
      changed = true;
    }
  }
  if (changed) writeOrders(orders);
}

export function getOrdersBySellerStores(storeSlugs: string[]): Order[] {
  const slugSet = new Set(storeSlugs);
  return readOrders()
    .filter((o) => o.items.some((i) => slugSet.has(i.storeSlug)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// productId → units actually SOLD (countsAsRevenue orders only — see the note
// inside). A "how popular is this product" signal for the seller, not a
// fulfillment one, but popularity measured on sales that stuck.
/** Pure half of `getPurchasedCountsByStoreSlug` — takes the orders instead of
 *  reading them, matching how seller-performance.ts / admin-stats.ts are built
 *  (pure, pre-fetched data). Exported so units can be tested on a real mixed
 *  order list without mocking the filesystem. */
export function purchasedCountsFrom(orders: Order[], storeSlug: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of orders) {
    // "Units sold" means sold: same rule as revenue, for the same reason. This
    // counted EVERY order — payment pending, payment failed, and cancelled
    // (already restocked) alike — and it is not just a dashboard column. It also
    // feeds the public storefront's popularity ordering AND `custom_label_1` in
    // the Merchant/Meta feed (product-labels.ts → performanceTier), where a
    // product inflated to "bestseller" by failed and cancelled orders pulls real
    // campaign budget toward itself.
    if (!countsAsRevenue(o)) continue;
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug) continue;
      counts[item.productId] = (counts[item.productId] ?? 0) + item.qty;
    }
  }
  return counts;
}

export function getPurchasedCountsByStoreSlug(storeSlug: string): Record<string, number> {
  return purchasedCountsFrom(readOrders(), storeSlug);
}

export function updateOrder(id: string, updates: Partial<Omit<Order, 'id' | 'createdAt'>>): Order | null {
  const orders = readOrders();
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx]!, ...updates, updatedAt: new Date().toISOString() };
  writeOrders(orders);
  return orders[idx]!;
}
