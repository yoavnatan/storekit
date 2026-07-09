export const prerender = false;
import crypto from 'node:crypto';
import type { APIContext } from 'astro';
import { getStoreBySlug } from '../../lib/stores.js';
import { getProductBySlug } from '../../lib/store-products.js';
import { createOrder } from '../../lib/orders.js';
import type { OrderItem, StoreSubtotal } from '../../lib/orders.js';
import { createNotification } from '../../lib/notifications.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, saveUserCart } from '../../lib/user-carts.js';
import { makeCartKey } from '../../lib/cart.js';

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

  const userId = getSellerSession(cookies);

  const buyerData = {
    ...(userId ? { buyerId: userId } : {}),
    buyerName:   buyerName.trim(),
    buyerEmail:  buyerEmail.trim().toLowerCase(),
    buyerPhone:  buyerPhone.trim(),
    buyerAddress: {
      city:   String(buyerAddress!.city).trim(),
      street: String(buyerAddress!.street).trim(),
      zip:    buyerAddress?.zip ? String(buyerAddress.zip).trim() : undefined,
    },
  };

  // Shared reference for the buyer to identify the full purchase across all stores
  const checkoutRef = crypto.randomUUID().slice(0, 8).toUpperCase();

  // Create one order per store so each seller owns a separate, isolated order
  const orderIds: string[] = [];
  for (const [storeSlug, sub] of Object.entries(storeSubtotals)) {
    const storeItems = orderItems.filter((i) => i.storeSlug === storeSlug);
    const storeTotalAmount = sub.subtotal + sub.shipping;
    const storeOrder = createOrder({
      ...buyerData,
      checkoutRef,
      items: storeItems,
      storeSubtotals: { [storeSlug]: sub },
      shippingAmount: sub.shipping,
      totalAmount:    storeTotalAmount,
    });
    orderIds.push(storeOrder.id);

    const store = getStoreBySlug(storeSlug);
    if (store) {
      createNotification({
        userId: store.sellerId,
        role: 'seller',
        type: 'new_order',
        title: 'הזמנה חדשה!',
        body: `הזמנה מ-${buyerData.buyerName} על סך ${storeTotalAmount.toFixed(2)} ₪`,
        relatedId: storeOrder.id,
      });
    }
  }

  // Remove only the purchased items from the server-side cart (buyer may have left
  // other items unselected at checkout) — preserves wishlist + favoriteStores.
  if (userId) {
    const existing = getUserCart(userId);
    const cart = { ...existing.cart };
    for (const raw of items) {
      const item = raw as CartItemInput;
      const storeSlug = typeof item.storeSlug === 'string' ? item.storeSlug.trim() : '';
      const productSlug = typeof item.productSlug === 'string' ? item.productSlug.trim() : '';
      const selectedVariants =
        item.selectedVariants && typeof item.selectedVariants === 'object' && !Array.isArray(item.selectedVariants)
          ? (item.selectedVariants as Record<string, string>)
          : undefined;
      const key = makeCartKey(productSlug, selectedVariants);
      const storeCart = cart[storeSlug];
      if (!storeCart) continue;
      const remainingItems = { ...storeCart.items };
      delete remainingItems[key];
      if (Object.keys(remainingItems).length === 0) delete cart[storeSlug];
      else cart[storeSlug] = { ...storeCart, items: remainingItems };
    }
    saveUserCart(userId, { cart, wishlist: existing.wishlist, favoriteStores: existing.favoriteStores ?? [] });
  }

  return json({ orderIds, checkoutRef }, 201);
}
