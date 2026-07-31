export const prerender = false;
import crypto from 'node:crypto';
import type { APIContext } from 'astro';
import { getStoreBySlug, getStoreBySlugOrPrevious, canStoreSell } from '../../lib/stores.js';
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
import { isValidEmail } from '../../lib/email-address.js';
import { makeCartKey } from '../../lib/cart.js';
import { logError } from '../../lib/error-log.js';
import { recordAnalyticsEvent } from '../../lib/analytics.js';
import { effectivePrice } from '../../lib/discounts.js';
import { claimCheckout, completeCheckout, releaseCheckout, isValidIdempotencyKey, checkoutOwner } from '../../lib/checkout-idempotency.js';
import { recordMoneyEvent } from '../../lib/money-events.js';
import { roundMoney, sumMoney } from '../../lib/money.js';

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
  /** Client-minted key identifying this checkout ATTEMPT, reused across retries so a
   *  repeat submit replays the first result instead of charging again. Required —
   *  see lib/checkout-idempotency.ts for why a missing one is not safe to wave through. */
  idempotencyKey?: unknown;
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

  const { buyerName, buyerEmail, buyerPhone, buyerAddress, items, deliveryMethods, idempotencyKey } = body;

  // Refused outright rather than waved through when absent: without a key this
  // endpoint cannot tell a second purchase from the same purchase arriving twice,
  // and the failure mode is charging a buyer twice (lib/checkout-idempotency.ts).
  // "Old clients might not send it" is not a reason to keep the unsafe path alive —
  // nothing has shipped yet, and the client is in this repo.
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return json({ error: 'Missing or malformed idempotencyKey' }, 400);
  }

  // Validate required buyer fields
  if (!isString(buyerName)) return json({ error: 'Missing buyerName' }, 400);
  if (!isValidEmail(buyerEmail)) return json({ error: 'Invalid buyerEmail' }, 400);
  if (!isString(buyerPhone)) return json({ error: 'Missing buyerPhone' }, 400);
  if (!isString(buyerAddress?.city)) return json({ error: 'Missing city' }, 400);
  if (!isString(buyerAddress?.street)) return json({ error: 'Missing street' }, 400);

  if (!Array.isArray(items) || items.length === 0) {
    return json({ error: 'Cart is empty' }, 400);
  }

  const userId = getSellerSession(cookies);

  // Pre-pass guards, both refusing the whole checkout before the loop below reserves any
  // stock — each is a static property of the store, so neither needs a rollback path.
  for (const raw of items) {
    const rawSlug = (raw as CartItemInput).storeSlug;
    const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    const preStore = slug ? getStoreBySlugOrPrevious(slug) : null;
    if (!preStore) continue;
    // Showcase store (lib/demo-stores.ts, GO_LIVE_CHECKLIST.md §6.2). Adding a demo
    // store's product to the cart is deliberately allowed — a prospective seller is
    // meant to walk the real buying flow — and only this last, irreversible step is
    // refused.
    if (isDemoStore(preStore)) return json({ error: 'demo-store' }, 403);
    // A seller may not buy from a store he owns. Such an order is real in every way
    // that matters — stock, commission, mail, the units that drive the `popular`/
    // `bestseller` label in the Google/Meta feed, and the first sale that starts his
    // monthly fee — so a curious click around his own storefront must not create one.
    // The storefront also refuses this client-side (lib/own-store-guard.ts), but a
    // hidden button is not a rule: the cart is client state and this endpoint is
    // directly callable. This is the guarantee; that is only the explanation.
    if (userId && preStore.sellerId === userId) return json({ error: 'own-store' }, 403);
  }

  // Binds the key to this buyer, so a completed record can only ever be replayed back to them.
  const owner = checkoutOwner(buyerEmail);
  // Claim the key BEFORE any stock is reserved. A repeat submit that got this far
  // would otherwise decrement stock a second time even if it were later stopped from
  // charging — the replay has to short-circuit ahead of every side effect, not just
  // the money one.
  // A prefix only. The key is half of what it takes to replay a completed checkout
  // (the buyer's email is the other half), so writing it whole into a journal the
  // admin reads — and that a future export or support paste could carry further —
  // would put a live token somewhere it has no reason to be. The prefix is still
  // enough to correlate the three entries of one incident.
  const keyForLog = `${idempotencyKey.slice(0, 8)}…`;

  const claim = await claimCheckout(idempotencyKey, owner);
  if (claim.status === 'conflict') {
    // This key completed for someone else. Not a retry — either a guessed key or a collision, and
    // the replay below would hand over that buyer's order references. Same generic shape as
    // in_progress on purpose: the response must not confirm that the key exists.
    await recordMoneyEvent({
      type: 'duplicate_checkout_blocked',
      actor: 'buyer',
      detail: `idempotencyKey=${keyForLog}; presented by a different buyer than the one who completed it`,
    });
    return json({ error: 'checkout-in-progress' }, 409);
  }
  if (claim.status === 'replay') {
    // The first attempt already succeeded; its response was just never received.
    // Hand back the exact same result — same orders, same ref — so the buyer lands
    // on their real confirmation page instead of paying again for it.
    await recordMoneyEvent({
      type: 'duplicate_checkout_blocked',
      checkoutRef: claim.record.checkoutRef,
      actor: 'buyer',
      detail: `idempotencyKey=${keyForLog}; replayed ${claim.record.orderIds?.length ?? 0} order(s)`,
    });
    return json({ orderIds: claim.record.orderIds ?? [], checkoutRef: claim.record.checkoutRef, replayed: true });
  }
  if (claim.status === 'in_progress') {
    // The first attempt is still at the gateway. Refusing is the safe answer: we
    // cannot know yet whether it will charge, so we must not start a second one.
    await recordMoneyEvent({
      type: 'duplicate_checkout_blocked',
      actor: 'buyer',
      detail: `idempotencyKey=${keyForLog}; concurrent submit while the first was still in flight`,
    });
    return json({ error: 'checkout-in-progress' }, 409);
  }

  const orderItems: OrderItem[] = [];
  const storeSubtotals: Record<string, StoreSubtotal> = {};
  const decremented: { productId: string; qty: number; selectedVariants?: Record<string, string> }[] = [];
  // Deferred until the order actually commits — a downstream failure rolls the
  // reservation back below, and a stray stock alert for a purchase that never
  // went through would be a false positive.
  const stockAlerts: { type: 'low_stock' | 'out_of_stock'; sellerId: string; storeSlug: string; storeName: string; productId: string; productName: string; stockAfter: number; selectedVariants?: Record<string, string> }[] = [];

  // Every failure path from here on has to undo BOTH reservations this request made:
  // the stock it decremented for earlier items in the same cart, and the idempotency
  // claim it is holding (which would otherwise make the buyer's immediate retry wait
  // out the pending TTL). Two of the "not found" checks below returned without
  // restocking at all, so a multi-item cart whose second item resolved to a missing
  // store left the first item's stock decremented against an order that never
  // existed. One helper on every exit is what keeps that from coming back.
  const abort = async (payload: Record<string, unknown>, status: number): Promise<Response> => {
    for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
    await releaseCheckout(idempotencyKey);
    return json(payload, status);
  };

  for (const raw of items) {
    const item = raw as CartItemInput;
    const storeSlug   = typeof item.storeSlug   === 'string' ? item.storeSlug.trim()   : '';
    const productSlug = typeof item.productSlug === 'string' ? item.productSlug.trim() : '';
    const qty         = typeof item.qty         === 'number' ? Math.floor(item.qty)    : 0;

    if (!storeSlug || !productSlug || qty <= 0) {
      return abort({ error: `Invalid item: storeSlug=${storeSlug} productSlug=${productSlug} qty=${qty}` }, 400);
    }

    // Tolerate a previous slug: if the seller renamed the store URL after this item entered the
    // cart, the client still sends the OLD slug — resolve it so the purchase never fails. Everything
    // downstream keys off store.slug (the current one) for consistency with the order records.
    const store = getStoreBySlugOrPrevious(storeSlug);
    if (!store) return abort({ error: `Store not found: ${storeSlug}` }, 400);
    // A store that may not sell — admin-blocked (admin-moderation.ts), closed, or paused by
    // its own seller (store-status.ts) — rejects the whole checkout rather than silently
    // dropping the item, same as "not found". A store changing state *while a cart sits open*
    // is a realistic mid-session event, not just a hard-to-hit deleted-product race: this is the
    // gate that makes "stop selling" mean it, whatever the buyer's page still shows.
    if (!canStoreSell(store)) return abort({ error: `Store not found: ${storeSlug}` }, 400);

    // Server-side price lookup — never trust client-sent prices
    const product = getProductBySlug(store.id, productSlug);
    if (!product) return abort({ error: `Product not found: ${productSlug}` }, 400);
    if (!isProductVisible(product)) return abort({ error: `Product not found: ${productSlug}` }, 400);

    const selectedVariants =
      item.selectedVariants && typeof item.selectedVariants === 'object' && !Array.isArray(item.selectedVariants)
        ? (item.selectedVariants as Record<string, string>)
        : undefined;

    // Reserve stock as each item is validated, not after every order is built — an
    // insufficient-stock item rolls back everything reserved before it and fails the
    // whole checkout instead of creating a partially-fulfillable order.
    const stockResult = await decrementStock(product.id, qty, selectedVariants);
    if (!stockResult.ok) {
      // A code plus the identity of the line that failed and how many units are really
      // left — not a prose sentence. This is the one rejection the buyer's page can
      // CORRECT rather than merely report (clamp the quantity, drop a sold-out line,
      // name the product), and it can only do that if it is told which line and what
      // number. The count comes from `before`, read inside the same mutex-protected
      // pass that refused the write, so it is the live figure and not a second read
      // that a concurrent checkout could already have moved.
      return abort({
        error: 'out-of-stock',
        outOfStock: {
          storeSlug: store.slug,
          productSlug: product.slug,
          productName: product.name,
          available: Math.max(0, stockResult.before),
          ...(selectedVariants ? { selectedVariants } : {}),
        },
      }, 409);
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

    // The charged price is derived server-side from the product AND its store's sale, exactly
    // like the storefront derives the displayed one — never `product.price` (which is the
    // pre-discount figure) and never the client's number. A sale that ended between page load
    // and submit therefore charges full price, and one that started charges the lower one.
    // Rounded to agorot at the point it becomes the charged price (lib/money.ts): a
    // percent-discount price is a raw division, and letting that tail through means
    // the line total, the subtotal and the amount handed to the gateway all carry it.
    const unitPrice = roundMoney(effectivePrice(product, store.sale));

    orderItems.push({
      productId:   product.id,
      productName: product.name,
      productSlug: product.slug,
      storeSlug:   store.slug,
      storeName:   store.name,
      price:       unitPrice,
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
    storeSubtotals[store.slug]!.subtotal = roundMoney(storeSubtotals[store.slug]!.subtotal + unitPrice * qty);
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

  const orderIds: string[] = [];
  const createdOrders: Order[] = [];
  // Flips the moment the order rows exist, and it is what the catch below reads.
  // Before it: a throw means no purchase happened, so the reserved stock goes back.
  // After it: the buyer HAS been charged and the orders are real, so restocking
  // would put sold units back on the shelf and oversell them — a failure in the
  // trailing steps (clearing the cart, analytics, confirmation mail) is not grounds
  // for undoing a completed purchase. The old catch rolled back either way.
  let committed = false;

  try {
    // Charge before committing any order. Today this is the mock provider (always
    // approves); at go-live the real gateway swaps in behind the same interface. A
    // decline rolls back the stock reserved above so no order exists for an unpaid cart.
    // NOTE: once a real provider charges here, a downstream throw after a SUCCESSFUL
    // charge will need a refund/void — add that alongside the real provider swap.
    const grandTotal = sumMoney(Object.values(storeSubtotals).flatMap((d) => [d.subtotal, d.shipping]));
    // The key travels to the provider too, so the gateway's OWN de-duplication backs
    // up ours: if our ledger write is lost between charging and recording, the retry
    // still reaches a provider that recognises the key and refuses to charge twice.
    const payment = await paymentProvider.charge({ amount: grandTotal, checkoutRef, buyerEmail: buyerData.buyerEmail, idempotencyKey });
    // Journalled whether it succeeded or failed — a decline is exactly the kind of
    // event that is invisible afterwards (no order row is left behind to show it
    // happened) and exactly what someone asks about later.
    await recordMoneyEvent({
      type: 'payment_attempted',
      checkoutRef,
      amount: grandTotal,
      actor: 'buyer',
      detail: payment.ok ? `approved ref=${payment.paymentRef ?? '—'}` : `declined: ${payment.error ?? 'unknown'}`,
    });
    if (!payment.ok) return abort({ error: payment.error ?? 'התשלום נכשל' }, 402);

    // Create one order per store so each seller owns a separate, isolated order
    for (const [storeSlug, sub] of Object.entries(storeSubtotals)) {
      const storeItems = orderItems.filter((i) => i.storeSlug === storeSlug);
      const storeTotalAmount = sumMoney([sub.subtotal, sub.shipping]);
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
      await recordMoneyEvent({
        type: 'order_created',
        orderId: storeOrder.id,
        checkoutRef,
        storeSlug,
        amount: storeTotalAmount,
        to: 'paid',
        actor: 'buyer',
        detail: `${storeItems.length} item(s); paymentRef=${payment.paymentRef ?? '—'}`,
      });

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

    // The purchase is now real. Record the key's result before anything else can
    // throw, so a retry replays these orders instead of buying them again.
    committed = true;
    await completeCheckout(idempotencyKey, checkoutRef, orderIds, owner);

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
    if (!committed) {
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      await releaseCheckout(idempotencyKey);
    }
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
      resolutionHint: committed
        ? 'ההזמנה נוצרה והתשלום עבר; הכשל היה בשלב שאחרי (ניקוי עגלה / מייל אישור). אין לבטל את ההזמנה — יש לבדוק שהמייל נשלח.'
        : 'כשל בביצוע ההזמנה; המלאי שוחזר אוטומטית. יש לנסות לבצע את ההזמנה שוב — אם התקלה חוזרת, יש לפנות לתמיכה עם מספר האסמכתא.',
    });
    // A post-commit failure still returns the successful response: the buyer paid
    // and the orders exist, so sending them an error would invite exactly the
    // duplicate purchase this endpoint now guards against.
    if (committed) return json({ orderIds, checkoutRef }, 201);
    return json({ error: 'Checkout failed, please try again' }, 500);
  }
}
