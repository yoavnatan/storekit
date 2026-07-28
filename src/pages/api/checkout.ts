export const prerender = false;
import crypto from 'node:crypto';
import type { APIContext } from 'astro';
import { getStoreBySlug, getStoreBySlugOrPrevious, isStoreVisible } from '../../lib/stores.js';
import { isDemoStore } from '../../lib/demo-stores.js';
import { getProductBySlug, decrementStock, restockProduct, LOW_STOCK_THRESHOLD, isProductVisible } from '../../lib/store-products.js';
import { createOrder } from '../../lib/orders.js';
import type { Order, OrderItem, StoreSubtotal } from '../../lib/orders.js';
import { paymentProvider } from '../../lib/payment.js';
import { normalizeDeliveryMethod, shippingPrice } from '../../lib/shipping.js';
import { sendOrderConfirmationEmails } from '../../lib/email/order-confirmation.js';
import { createNotification } from '../../lib/notifications.js';
import { getSellerSession } from '../../lib/seller-auth.js';
import { getUserCart, saveUserCart } from '../../lib/user-carts.js';
import { makeCartKey } from '../../lib/cart.js';
import { logError } from '../../lib/error-log.js';
import { recordAnalyticsEvent } from '../../lib/analytics.js';

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
  /** Buyer's chosen delivery method per store, keyed by (current) store slug. Untrusted —
   *  each value is re-validated against what the store actually offers, and the price is
   *  recomputed server-side from the central platform rate. */
  deliveryMethods?: Record<string, unknown>;
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

/** Identifies which product name a stock alert should read — the exact variant combo that crossed the threshold, not just the product, so the seller knows what to restock. */
function describeStockAlertProduct(productName: string, selectedVariants?: Record<string, string>): string {
  if (!selectedVariants || !Object.keys(selectedVariants).length) return productName;
  const combo = Object.entries(selectedVariants).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `${productName} (${combo})`;
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  let body: CheckoutBody;
  try {
    body = await request.json() as CheckoutBody;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { buyerName, buyerEmail, buyerPhone, buyerAddress, items, deliveryMethods } = body;

  // Validate required buyer fields
  if (!isString(buyerName)) return json({ error: 'Missing buyerName' }, 400);
  if (!isString(buyerEmail) || !isValidEmail(buyerEmail)) return json({ error: 'Invalid buyerEmail' }, 400);
  if (!isString(buyerPhone)) return json({ error: 'Missing buyerPhone' }, 400);
  if (!isString(buyerAddress?.city)) return json({ error: 'Missing city' }, 400);
  if (!isString(buyerAddress?.street)) return json({ error: 'Missing street' }, 400);

  if (!Array.isArray(items) || items.length === 0) {
    return json({ error: 'Cart is empty' }, 400);
  }

  // Showcase-store guard (lib/demo-stores.ts, GO_LIVE_CHECKLIST.md §6.2). Adding a
  // demo store's product to the cart is deliberately allowed — a prospective seller
  // is meant to walk the real buying flow — and only this last, irreversible step is
  // refused. Enforced on the server because a hidden button is not a rule: the cart
  // is client state and this endpoint is directly callable. Runs as a pre-pass,
  // before the loop below reserves any stock, since being a demo store is a static
  // property of the store and needs no rollback path.
  for (const raw of items) {
    const rawSlug = (raw as CartItemInput).storeSlug;
    const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    const demoStore = slug ? getStoreBySlugOrPrevious(slug) : null;
    if (demoStore && isDemoStore(demoStore)) return json({ error: 'demo-store' }, 403);
  }

  const orderItems: OrderItem[] = [];
  const storeSubtotals: Record<string, StoreSubtotal> = {};
  const decremented: { productId: string; qty: number; selectedVariants?: Record<string, string> }[] = [];
  // Deferred until the order actually commits — a downstream failure rolls the
  // reservation back below, and a stray stock alert for a purchase that never
  // went through would be a false positive.
  const stockAlerts: { type: 'low_stock' | 'out_of_stock'; sellerId: string; storeSlug: string; storeName: string; productId: string; productName: string; stockAfter: number; selectedVariants?: Record<string, string> }[] = [];

  for (const raw of items) {
    const item = raw as CartItemInput;
    const storeSlug   = typeof item.storeSlug   === 'string' ? item.storeSlug.trim()   : '';
    const productSlug = typeof item.productSlug === 'string' ? item.productSlug.trim() : '';
    const qty         = typeof item.qty         === 'number' ? Math.floor(item.qty)    : 0;

    if (!storeSlug || !productSlug || qty <= 0) {
      return json({ error: `Invalid item: storeSlug=${storeSlug} productSlug=${productSlug} qty=${qty}` }, 400);
    }

    // Tolerate a previous slug: if the seller renamed the store URL after this item entered the
    // cart, the client still sends the OLD slug — resolve it so the purchase never fails. Everything
    // downstream keys off store.slug (the current one) for consistency with the order records.
    const store = getStoreBySlugOrPrevious(storeSlug);
    if (!store) return json({ error: `Store not found: ${storeSlug}` }, 400);
    // Admin-blocked store (see admin-moderation.ts) — reject the whole
    // checkout rather than silently drop the item, same as "not found". Rolls
    // back stock already reserved for earlier items in this same cart (a
    // multi-item order where an earlier item committed fine) — unlike the
    // pre-existing "not found" checks around this one, a store/product going
    // blocked *while a cart sits open* is a realistic mid-session admin
    // action, not just a hard-to-hit deleted-product race.
    if (!isStoreVisible(store)) {
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      return json({ error: `Store not found: ${storeSlug}` }, 400);
    }

    // Server-side price lookup — never trust client-sent prices
    const product = getProductBySlug(store.id, productSlug);
    if (!product) return json({ error: `Product not found: ${productSlug}` }, 400);
    if (!isProductVisible(product)) {
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      return json({ error: `Product not found: ${productSlug}` }, 400);
    }

    const selectedVariants =
      item.selectedVariants && typeof item.selectedVariants === 'object' && !Array.isArray(item.selectedVariants)
        ? (item.selectedVariants as Record<string, string>)
        : undefined;

    // Reserve stock as each item is validated, not after every order is built — an
    // insufficient-stock item rolls back everything reserved before it and fails the
    // whole checkout instead of creating a partially-fulfillable order.
    const stockResult = await decrementStock(product.id, qty, selectedVariants);
    if (!stockResult.ok) {
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      return json({ error: `אזל המלאי: ${product.name}` }, 409);
    }
    decremented.push({ productId: product.id, qty, selectedVariants });

    // Fire once, right as stock crosses a threshold going down — not on every
    // subsequent order while it stays low/empty (that'd spam the seller on every
    // sale of an already-flagged product). before/after come from inside
    // decrementStock's own mutex-protected write, not a separate read, so a
    // concurrent checkout on the same product can't skew which side of a
    // threshold this looks like it's on. Mutually exclusive per item: a single
    // order that takes stock straight from above the threshold to zero only
    // gets the more severe out-of-stock alert — low-stock is implied by it, and
    // sending both for the same event is redundant noise, not "two things to know".
    if (stockResult.before > 0 && stockResult.after <= 0) {
      stockAlerts.push({ type: 'out_of_stock', sellerId: store.sellerId, storeSlug: store.slug, storeName: store.name, productId: product.id, productName: product.name, stockAfter: stockResult.after, selectedVariants });
    } else if (stockResult.before > LOW_STOCK_THRESHOLD && stockResult.after <= LOW_STOCK_THRESHOLD) {
      stockAlerts.push({ type: 'low_stock', sellerId: store.sellerId, storeSlug: store.slug, storeName: store.name, productId: product.id, productName: product.name, stockAfter: stockResult.after, selectedVariants });
    }

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

    // Key by store.slug (the CURRENT slug), not the client-sent one — so if the item entered the
    // cart under an old slug, the subtotals/shipping/order grouping all stay consistent with the
    // order items (which also record store.slug).
    if (!storeSubtotals[store.slug]) {
      storeSubtotals[store.slug] = { storeName: store.name, subtotal: 0, shipping: 0 };
    }
    storeSubtotals[store.slug]!.subtotal += product.price * qty;
  }

  // Delivery method + shipping price per store — server-authoritative. The buyer's chosen
  // method is re-validated against what each store actually offers (self-pickup only if
  // the seller enabled it AND the store has an address); the price is the central platform
  // rate (lib/shipping.ts), never a client value and never seller-set. Self-pickup is free.
  const clientMethods = (deliveryMethods && typeof deliveryMethods === 'object' && !Array.isArray(deliveryMethods))
    ? deliveryMethods as Record<string, unknown>
    : {};
  let totalShipping = 0;
  for (const [storeSlug, data] of Object.entries(storeSubtotals)) {
    const store = getStoreBySlug(storeSlug);
    const offersSelfPickup = !!store?.shipping?.selfPickup && !!store?.address;
    const method = normalizeDeliveryMethod(clientMethods[storeSlug], offersSelfPickup);
    data.deliveryMethod = method;
    data.shipping = shippingPrice(method);
    totalShipping += data.shipping;
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

  // Everything below only mutates in-memory data until it's written out (orders,
  // notifications, the buyer's cart) — if any of it throws, the stock already
  // reserved above must go back rather than sit decremented for an order that
  // never actually got created.
  try {
    // Charge before committing any order. Today this is the mock provider (always
    // approves); at go-live the real gateway swaps in behind the same interface. A
    // decline rolls back the stock reserved above so no order exists for an unpaid cart.
    // NOTE: once a real provider charges here, a downstream throw after a SUCCESSFUL
    // charge will need a refund/void — add that alongside the real provider swap.
    const grandTotal = Object.values(storeSubtotals).reduce((sum, d) => sum + d.subtotal + d.shipping, 0);
    const payment = await paymentProvider.charge({ amount: grandTotal, checkoutRef, buyerEmail: buyerData.buyerEmail });
    if (!payment.ok) {
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      return json({ error: payment.error ?? 'התשלום נכשל' }, 402);
    }

    // Create one order per store so each seller owns a separate, isolated order
    const orderIds: string[] = [];
    const createdOrders: Order[] = [];
    for (const [storeSlug, sub] of Object.entries(storeSubtotals)) {
      const storeItems = orderItems.filter((i) => i.storeSlug === storeSlug);
      const storeTotalAmount = sub.subtotal + sub.shipping;
      const storeOrder = createOrder({
        ...buyerData,
        checkoutRef,
        paymentStatus: 'paid',
        paymentRef: payment.paymentRef,
        items: storeItems,
        storeSubtotals: { [storeSlug]: sub },
        shippingAmount: sub.shipping,
        totalAmount:    storeTotalAmount,
      });
      orderIds.push(storeOrder.id);
      createdOrders.push(storeOrder);

      const store = getStoreBySlug(storeSlug);
      if (store) {
        createNotification({
          userId: store.sellerId,
          role: 'seller',
          type: 'new_order',
          title: 'הזמנה חדשה!',
          body: `הזמנה מ-${buyerData.buyerName} על סך ${storeTotalAmount.toFixed(2)} ₪`,
          relatedId: storeOrder.id,
          storeSlug: store.slug,
          storeName: store.name,
        });
      }
    }

    for (const alert of stockAlerts) {
      const label = describeStockAlertProduct(alert.productName, alert.selectedVariants);
      createNotification({
        userId: alert.sellerId,
        role: 'seller',
        type: alert.type,
        title: alert.type === 'out_of_stock' ? 'המוצר אזל מהמלאי' : 'מלאי נמוך',
        body: alert.type === 'out_of_stock'
          ? `"${label}" אזל לגמרי מהמלאי`
          : `נותרו ${alert.stockAfter} יחידות בלבד מ"${label}"`,
        relatedId: alert.productId,
        storeSlug: alert.storeSlug,
        storeName: alert.storeName,
      });
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

    // First-party funnel: the purchase stage. Recorded server-side after the
    // order commits (never client-side) so an ad-blocker or a closed tab can't
    // drop it; the sn_vid session ties it back to this shopper's earlier
    // add_to_cart for the cart-abandonment math. Fire-and-forget, never throws.
    recordAnalyticsEvent('purchase', {
      vid: cookies.get('sn_vid')?.value,
      productIds: decremented.map((d) => d.productId),
    });

    // Order-confirmation emails — the one channel that reaches GUEST buyers (no
    // in-app account). Fire-and-forget: the order is already committed, so a
    // slow/failed provider must not delay or fail the checkout response. Every
    // send is internally resilient (never throws) and logs its own failures.
    void sendOrderConfirmationEmails(createdOrders).catch(() => { /* fully handled inside */ });

    return json({ orderIds, checkoutRef }, 201);
  } catch (err) {
    for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
    const storeSlugs = Object.keys(storeSubtotals);
    logError({
      source: 'server',
      route: '/api/checkout',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      actorRole: 'buyer',
      actorId: userId ?? undefined,
      actorLabel: typeof buyerEmail === 'string' ? buyerEmail : undefined,
      storeSlug: storeSlugs.length ? storeSlugs.join(', ') : undefined,
      storeName: storeSlugs.length ? storeSlugs.map((s) => storeSubtotals[s]!.storeName).join(', ') : undefined,
      resolutionHint: 'כשל בביצוע ההזמנה; המלאי שוחזר אוטומטית. יש לנסות לבצע את ההזמנה שוב — אם התקלה חוזרת, יש לפנות לתמיכה עם מספר האסמכתא.',
    });
    return json({ error: 'Checkout failed, please try again' }, 500);
  }
}
