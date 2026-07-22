import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  createdAt: string;
  updatedAt: string;
}

export type CreateOrderInput = Omit<Order, 'id' | 'paymentStatus' | 'shippingStatus' | 'createdAt' | 'updatedAt'>;

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
    // No live payment gateway yet (split-payment integration is still on the
    // roadmap) — checkout only ever creates an Order after collecting payment
    // details, so by the time one exists here it's already "paid" in this
    // stub sense. Once a real webhook-based confirm step lands, that should
    // become the sole place paymentStatus is set.
    paymentStatus: 'paid',
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

export function getOrdersByStoreSlug(storeSlug: string): Order[] {
  return readOrders()
    .filter((o) => o.items.some((i) => i.storeSlug === storeSlug))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getOrdersBySellerStores(storeSlugs: string[]): Order[] {
  const slugSet = new Set(storeSlugs);
  return readOrders()
    .filter((o) => o.items.some((i) => slugSet.has(i.storeSlug)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// productId → total units ever ordered (all payment/shipping statuses — a
// "how popular is this product" signal for the seller, not a fulfillment one).
export function getPurchasedCountsByStoreSlug(storeSlug: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const o of readOrders()) {
    for (const item of o.items) {
      if (item.storeSlug !== storeSlug) continue;
      counts[item.productId] = (counts[item.productId] ?? 0) + item.qty;
    }
  }
  return counts;
}

export function updateOrder(id: string, updates: Partial<Omit<Order, 'id' | 'createdAt'>>): Order | null {
  const orders = readOrders();
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return null;
  orders[idx] = { ...orders[idx]!, ...updates, updatedAt: new Date().toISOString() };
  writeOrders(orders);
  return orders[idx]!;
}
