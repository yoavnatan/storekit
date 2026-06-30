export const prerender = false;
import type { APIContext } from 'astro';
import { getStoreBySlug } from '../../lib/stores.js';
import { getProductBySlug } from '../../lib/store-products.js';
import { createOrder } from '../../lib/orders.js';
import type { OrderItem, StoreSubtotal } from '../../lib/orders.js';
import { createNotification } from '../../lib/notifications.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, saveUserCart } from '../../lib/user-carts.js';

interface CartItemInput {
  storeSlug: unknown;
  productSlug: unknown;
  qty: unknown;
  selectedVariants?: unknown;
}

interface CheckoutBody {
  buyerName?: unknown;
  buyerEmail?: unknown;
  buyerPhone?: unknown;
  buyerAddress?: {
    city?: unknown;
    street?: unknown;
    zip?: unknown;
  };
  items?: unknown[];
}

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  let body: CheckoutBody;
  try {
    body = await request.json() as CheckoutBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { buyerName, buyerEmail, buyerPhone, buyerAddress, items } = body;

  // Validate required buyer fields
  if (!isString(buyerName)) return json({ error: 'Missing buyerName' }, 400);
  if (!isString(buyerEmail) || !isValidEmail(buyerEmail)) return json({ error: 'Invalid buyerEmail' }, 400);
  if (!isString(buyerPhone)) return json({ error: 'Missing buyerPhone' }, 400);
  if (!isString(buyerAddress?.city)) return json({ error: 'Missing city' }, 400);
  if (!isString(buyerAddress?.street)) return json({ error: 'Missing street' }, 400);

  if (!Array.isArray(items) || items.length === 0) {
    return json({ error: 'Cart is empty' }, 400);
  }

  const orderItems: OrderItem[] = [];
  const storeSubtotals: Record<string, StoreSubtotal> = {};

  for (const raw of items) {
    const item = raw as CartItemInput;
    const storeSlug   = typeof item.storeSlug   === 'string' ? item.storeSlug.trim()   : '';
    const productSlug = typeof item.productSlug === 'string' ? item.productSlug.trim() : '';
    const qty         = typeof item.qty         === 'number' ? Math.floor(item.qty)    : 0;

    if (!storeSlug || !productSlug || qty <= 0) {
      return json({ error: `Invalid item: storeSlug=${storeSlug} productSlug=${productSlug} qty=${qty}` }, 400);
    }

    const store = getStoreBySlug(storeSlug);
    if (!store) return json({ error: `Store not found: ${storeSlug}` }, 400);

    // Server-side price lookup — never trust client-sent prices
    const product = getProductBySlug(store.id, productSlug);
    if (!product) return json({ error: `Product not found: ${productSlug}` }, 400);

    const selectedVariants =
      item.selectedVariants && typeof item.selectedVariants === 'object' && !Array.isArray(item.selectedVariants)
        ? (item.selectedVariants as Record<string, string>)
        : undefined;

    orderItems.push({
      productId:   product.id,
      productName: product.name,
      productSlug: product.slug,
      storeSlug:   store.slug,
      storeName:   store.name,
      price:       product.price,
      qty,
      image:       product.images?.[0],
      ...(selectedVariants ? { selectedVariants } : {}),
    });

    if (!storeSubtotals[storeSlug]) {
      storeSubtotals[storeSlug] = { storeName: store.name, subtotal: 0, shipping: 0 };
    }
    storeSubtotals[storeSlug]!.subtotal += product.price * qty;
  }

  // Calculate shipping per store (server-side, from store config)
  let totalShipping = 0;
  for (const [storeSlug, data] of Object.entries(storeSubtotals)) {
    const store = getStoreBySlug(storeSlug);
    const flatRate  = store?.shipping?.flatRate  ?? 0;
    const freeAbove = store?.shipping?.freeAbove ?? null;
    const shipping  = (freeAbove !== null && data.subtotal >= freeAbove) ? 0 : flatRate;
    data.shipping = shipping;
    totalShipping += shipping;
  }

  const itemsTotal  = Object.values(storeSubtotals).reduce((s, d) => s + d.subtotal, 0);
  const totalAmount = itemsTotal + totalShipping;

  const userId = getSellerSession(cookies);

  const order = createOrder({
    ...(userId ? { buyerId: userId } : {}),
    buyerName:   buyerName.trim(),
    buyerEmail:  buyerEmail.trim().toLowerCase(),
    buyerPhone:  buyerPhone.trim(),
    buyerAddress: {
      city:   String(buyerAddress!.city).trim(),
      street: String(buyerAddress!.street).trim(),
      zip:    buyerAddress?.zip ? String(buyerAddress.zip).trim() : undefined,
    },
    items:          orderItems,
    storeSubtotals,
    shippingAmount: totalShipping,
    totalAmount,
  });

  // Clear server-side cart for logged-in users (preserves wishlist + favoriteStores)
  if (userId) {
    const existing = getUserCart(userId);
    saveUserCart(userId, { cart: {}, wishlist: existing.wishlist, favoriteStores: existing.favoriteStores ?? [] });
  }

  // Notify each store's seller about the new order
  const notifiedSellers = new Set<string>();
  for (const [storeSlug] of Object.entries(storeSubtotals)) {
    const store = getStoreBySlug(storeSlug);
    if (store && !notifiedSellers.has(store.sellerId)) {
      notifiedSellers.add(store.sellerId);
      createNotification({
        userId: store.sellerId,
        role: 'seller',
        type: 'new_order',
        title: 'הזמנה חדשה!',
        body: `הזמנה מ-${order.buyerName} על סך ${totalAmount.toFixed(2)}₪`,
        relatedId: order.id,
      });
    }
  }

  return json({ orderId: order.id }, 201);
}
