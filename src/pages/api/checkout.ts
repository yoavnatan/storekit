export const prerender = false;
import crypto from 'node:crypto';
import type { APIContext } from 'astro';
import { getStoreBySlug, getStoreBySlugOrPrevious, canStoreSell } from '../../lib/stores.js';
import { isDemoStore } from '../../lib/demo-stores.js';
import { getProductBySlug, decrementStock, restockProduct, LOW_STOCK_THRESHOLD, isProductVisible } from '../../lib/store-products.js';
import { createOrder, updateOrder } from '../../lib/orders.js';
import type { Order, OrderItem, StoreSubtotal } from '../../lib/orders.js';
import { paymentProvider } from '../../lib/payment.js';
import { normalizeDeliveryMethod, shippingPrice } from '../../lib/shipping.js';
import { sendOrderConfirmationEmails } from '../../lib/email/order-confirmation.js';
import { createNotification } from '../../lib/notifications.js';
import { getSellerByEmail, getSellerSession } from '../../lib/seller-auth.js';
import { removeCartLines, type CartLineRef } from '../../lib/user-carts.js';
import { isValidEmail } from '../../lib/email-address.js';
import { makeCartKey } from '../../lib/cart.js';
import { logError } from '../../lib/error-log.js';
import { recordAnalyticsEvent } from '../../lib/analytics.js';
import { effectivePrice } from '../../lib/discounts.js';
import { claimCheckout, completeCheckout, releaseCheckout, isValidIdempotencyKey, checkoutOwner } from '../../lib/checkout-idempotency.js';
import { recordMoneyEvent } from '../../lib/money-events.js';
import { storeSliceTotalAgorot } from '../../lib/order-totals.js';
import { toAgorot, fromAgorot, formatAgorot } from '../../lib/money.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { readAttribution } from '../../lib/attribution.js';
import { getCouponByCode, claimCoupon, releaseCoupon } from '../../lib/store-coupons.js';
import { checkCoupon, normalizeCouponCode } from '../../lib/coupons.js';

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
  /** Coupon code the buyer typed for each store, keyed by (current) store slug. Untrusted in every
   *  way that matters: the code is re-looked-up against that store, re-checked against the schedule
   *  and the remaining uses, and the money it takes off is recomputed here — the client's own figure
   *  is never read. An invalid one FAILS the checkout rather than being dropped, because a buyer who
   *  was shown a discount and charged without it is the one outcome this must not produce. */
  coupons?: Record<string, unknown>;
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

/**
 * Release a hold that will never be captured, and make the outcome impossible to miss.
 *
 * **Never throws.** It runs inside a failure path that still has to restock, release the
 * idempotency claim and log — a compensation that can itself throw would turn one bad outcome into
 * four. Its own failure is not swallowed either: it is journalled and it comes back in the return
 * value, because "we could not give it back" is the one case a person must handle by hand.
 */
async function voidRefund(
  hold: { paymentRef: string; amountAgorot: number },
  checkoutRef: string,
  idempotencyKey: string,
  reason: unknown,
): Promise<'voided' | 'void-failed'> {
  const why = reason instanceof Error ? reason.message : String(reason);
  let outcome: 'voided' | 'void-failed' = 'void-failed';
  let detail: string;
  try {
    const res = await paymentProvider.voidCharge({
      paymentRef: hold.paymentRef,
      idempotencyKey,
      amount: fromAgorot(hold.amountAgorot),
      reason: why.slice(0, 200),
    });
    outcome = res.ok ? 'voided' : 'void-failed';
    detail = res.ok ? `released ref=${hold.paymentRef}` : `RELEASE FAILED ref=${hold.paymentRef}: ${res.error ?? 'unknown'}`;
  } catch (e) {
    detail = `RELEASE THREW ref=${hold.paymentRef}: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Journalled either way. A released hold is a row nobody needs to act on; a failed release is
  // money sitting on somebody's card, and it is the single most important row this journal can
  // hold — so it is written before the alert, where nothing can drop it.
  await recordMoneyEvent({
    type: 'charge_voided',
    checkoutRef,
    amountAgorot: hold.amountAgorot,
    actor: 'buyer',
    detail: `${detail}; cause: ${why.slice(0, 160)}`,
  }).catch(() => { /* the logError below still reports the whole failure */ });
  if (outcome === 'void-failed') {
    await logError({
      source: 'server',
      route: '/api/checkout',
      message: `Authorization could not be released: ${detail}`,
      statusCode: 500,
      actorRole: 'buyer',
      resolutionHint: '‼️ יש החזקה על כרטיס הקונה שלא שוחררה, ואין מולה הזמנה. נדרשת פעולה ידנית מול ספק הסליקה לפי מספר האסמכתא. זו התקלה היחידה כאן שעולה לקונה כסף.',
    }).catch(() => { /* nothing left to try */ });
  }
  return outcome;
}

/** Capture failed: the orders exist but no money was taken, so they must never look sellable.
 *  Marked rather than deleted — a money record is evidence. Never throws, same reason as above. */
async function failCapture(orderIds: string[], checkoutRef: string, amountAgorot: number, error?: string): Promise<void> {
  for (const id of orderIds) {
    await updateOrder(id, { paymentStatus: 'failed', shippingStatus: 'cancelled' })
      .catch(() => { /* reported by the money event below */ });
  }
  await recordMoneyEvent({
    type: 'payment_status_changed',
    checkoutRef,
    amountAgorot,
    to: 'failed',
    actor: 'buyer',
    detail: `capture failed: ${error ?? 'unknown'}; ${orderIds.length} order(s) cancelled, stock restored`,
  }).catch(() => { /* the endpoint's own logError still fires */ });
}

/** The orders were written pending and the capture has now succeeded. This is the ONLY place a
 *  checkout marks an order paid, and it runs strictly after the money moved. */
async function markOrdersPaid(orderIds: string[], checkoutRef: string, paymentRef?: string): Promise<void> {
  for (const id of orderIds) {
    await updateOrder(id, { paymentStatus: 'paid' });
  }
  await recordMoneyEvent({
    type: 'payment_status_changed',
    checkoutRef,
    to: 'paid',
    actor: 'buyer',
    detail: `captured ref=${paymentRef ?? '—'}; ${orderIds.length} order(s)`,
  });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  const read = await readJsonBody<CheckoutBody>(request, BODY_LIMIT.collection);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON body' }, read.status);
  const body = read.value;

  const { buyerName, buyerEmail, buyerPhone, buyerAddress, items, deliveryMethods, coupons, idempotencyKey } = body;

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

  // **Who this buyer is, as a seller account — by SESSION and by EMAIL, not by session alone.**
  //
  // The guard below used to ask only "is the signed-in user this store's owner", which left the
  // likeliest version of the problem wide open: a seller checking that his own checkout works
  // does it from his phone or a private window, i.e. signed OUT, and that is precisely the person
  // for whom an accidental first sale is expensive (it starts his monthly fee). The address he
  // types is the same identity the session would have proved.
  //
  // One lookup, before the loop rather than per item, so a ten-store cart still costs one query;
  // `citext` on the column makes the match case-insensitive, which is what stops `A@x.com` from
  // walking past it. Both identities are collected rather than one-or-the-other — checking only
  // the session is the hole being closed, and checking only the email would reopen it for a
  // seller signed in who types a different address.
  const buyerSellerIds = new Set<string>();
  if (userId) buyerSellerIds.add(userId);
  const buyerAccount = await getSellerByEmail(buyerEmail);
  if (buyerAccount) buyerSellerIds.add(buyerAccount.id);

  // Pre-pass guards, both refusing the whole checkout before the loop below reserves any
  // stock — each is a static property of the store, so neither needs a rollback path.
  for (const raw of items) {
    const rawSlug = (raw as CartItemInput).storeSlug;
    const slug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    const preStore = slug ? await getStoreBySlugOrPrevious(slug) : null;
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
    //
    // Buying from ANOTHER seller's store is untouched by this — the rule is about his own.
    if (buyerSellerIds.has(preStore.sellerId)) return json({ error: 'own-store' }, 403);
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
  // Coupon uses consumed by THIS request. A claim is a reservation exactly like a stock decrement,
  // and it has to be undone on every path that undoes the stock — otherwise a declined card burns
  // a use of a capped code and the fiftieth customer is turned away for a purchase that never
  // happened. Kept beside `decremented` so the two are impossible to unwind separately.
  const couponClaims: string[] = [];
  // What the buyer was actually trying to buy, in words, kept only so a failure can say so.
  //
  // The error entry already names the buyer and the store; without this it cannot name the thing.
  // "A buyer could not complete a purchase" is where triage starts, and "which item" is very often
  // where it ENDS — a single product with a bad variant or a bad price is the usual cause, and
  // recovering it afterwards means reconstructing a cart that no longer exists. Names rather than
  // ids, because this is read by a person; `decremented` keeps the ids for the restock.
  const attempted: string[] = [];
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
    for (const id of couponClaims) await releaseCoupon(id);
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
    const store = await getStoreBySlugOrPrevious(storeSlug);
    if (!store) return abort({ error: `Store not found: ${storeSlug}` }, 400);
    // A store that may not sell — admin-blocked (admin-moderation.ts), closed, or paused by
    // its own seller (store-status.ts) — rejects the whole checkout rather than silently
    // dropping the item, same as "not found". A store changing state *while a cart sits open*
    // is a realistic mid-session event, not just a hard-to-hit deleted-product race: this is the
    // gate that makes "stop selling" mean it, whatever the buyer's page still shows.
    if (!canStoreSell(store)) return abort({ error: `Store not found: ${storeSlug}` }, 400);

    // Server-side price lookup — never trust client-sent prices
    const product = await getProductBySlug(store.id, productSlug);
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
      // number. The count comes from `before`, resolved by the same statement that
      // refused the write, so it is the live figure and not a second read that a
      // concurrent checkout could already have moved.
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
    attempted.push(`${product.name} ×${qty}${selectedVariants ? ` (${Object.values(selectedVariants).join('/')})` : ''}`);

    // Fire once, right as stock crosses a threshold going down — not on every
    // subsequent order while it stays low/empty (that'd spam the seller on every
    // sale of an already-flagged product). before/after are RETURNING values of
    // decrementStock's own conditional UPDATE, not a separate read, so a
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
    // Converted to integer agorot at the point it becomes the CHARGED price (lib/money.ts): a
    // percent-discount price is a raw division, so this is the last moment the amount is allowed
    // to be fractional. Everything downstream of this line — the line total, the subtotal, the
    // grand total handed to the gateway, the order rows and the journal — is an integer, so the
    // tail cannot re-enter and there is nothing left to round a second time.
    const unitPriceAgorot = toAgorot(effectivePrice(product, store.sale));

    orderItems.push({
      productId:   product.id,
      productName: product.name,
      productSlug: product.slug,
      storeSlug:   store.slug,
      storeName:   store.name,
      priceAgorot: unitPriceAgorot,
      qty,
      image:       product.images?.[0],
      ...(selectedVariants ? { selectedVariants } : {}),
    });

    // Key by store.slug (the CURRENT slug), not the client-sent one — so if the item entered the
    // cart under an old slug, the subtotals/shipping/order grouping all stay consistent with the
    // order items (which also record store.slug).
    if (!storeSubtotals[store.slug]) {
      storeSubtotals[store.slug] = { storeName: store.name, subtotalAgorot: 0, shippingAgorot: 0 };
    }
    storeSubtotals[store.slug]!.subtotalAgorot += unitPriceAgorot * qty;
  }

  // Delivery method + shipping price per store — server-authoritative. The buyer's chosen
  // method is re-validated against what each store actually offers (self-pickup only if
  // the seller enabled it AND the store has an address); the price is the central platform
  // rate (lib/shipping.ts), never a client value and never seller-set. Self-pickup is free.
  const clientMethods = (deliveryMethods && typeof deliveryMethods === 'object' && !Array.isArray(deliveryMethods))
    ? deliveryMethods as Record<string, unknown>
    : {};
  const clientCoupons = (coupons && typeof coupons === 'object' && !Array.isArray(coupons))
    ? coupons as Record<string, unknown>
    : {};
  const now = new Date();
  for (const [storeSlug, data] of Object.entries(storeSubtotals)) {
    const store = await getStoreBySlug(storeSlug);
    const offersSelfPickup = !!store?.shipping?.selfPickup && !!store?.address;
    const method = normalizeDeliveryMethod(clientMethods[storeSlug], offersSelfPickup);
    data.deliveryMethod = method;
    // `shippingPrice` is a config rate in ILS — the last ILS number to enter the pipeline, and it
    // converts here rather than being trusted to already be whole agorot.
    data.shippingAgorot = toAgorot(shippingPrice(method));

    // ── The coupon, in the same pass, off the store this loop already fetched ──
    //
    // Here rather than in the item loop because a coupon applies to the SUBTOTAL, which only
    // exists once every line of that store has been priced. Everything about it is re-derived:
    // the code is looked up against THIS store (a code is one seller's to give, and a valid code
    // from another shop must not apply here), the schedule and the remaining uses are re-checked
    // against the database, and `checkCoupon` recomputes the money from the subtotal we just
    // built. The client's number is never read — it is only ever a preview.
    const code = normalizeCouponCode(clientCoupons[storeSlug]);
    if (!code || !store) continue;
    const coupon = await getCouponByCode(store.id, code);
    // Refused, not ignored. A buyer who was shown "−₪20" and charged the full amount would have no
    // way to know, and "the code expired while you were typing your address" is a sentence their
    // page can act on — it re-renders without the discount and they press pay again.
    if (!coupon) return abort({ error: 'coupon-invalid', coupon: { storeSlug, code, reason: 'unknown' } }, 409);
    const verdict = checkCoupon(coupon, data.subtotalAgorot, now);
    if (!verdict.ok) return abort({ error: 'coupon-invalid', coupon: { storeSlug, code, reason: verdict.reason } }, 409);
    // The claim is the reservation, and it is what makes a capped code mean its cap under
    // concurrency (store-coupons.ts#claimCoupon). It happens BEFORE the money is authorized, for
    // the same reason the stock decrement does: a reservation that can be released is safe to take
    // early, and a limit checked after the charge is not a limit.
    if (!(await claimCoupon(coupon.id))) {
      return abort({ error: 'coupon-invalid', coupon: { storeSlug, code, reason: 'exhausted' } }, 409);
    }
    couponClaims.push(coupon.id);
    // Written into the order-level discount slot every money surface already subtracts, with the
    // code beside it as provenance (orders.ts#StoreSubtotal.couponCode, migrations/0020).
    data.discount = { type: coupon.kind, value: coupon.value, appliedAgorot: verdict.appliedAgorot };
    data.couponCode = coupon.code;
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

  // The ad click that produced this purchase, off the first-party cookie middleware wrote when the
  // buyer landed (lib/attribution.ts, GO_LIVE §2.5 layer 5). Read from the COOKIE and never from
  // the request body, for the same reason prices are: the client would otherwise be choosing which
  // campaign gets credited, and once a campaign's spend is billed to a seller that is money.
  //
  // Stamped identically on every order of this checkout — a multi-store cart is one click, and
  // splitting the credit or giving it to the first store would both be inventions. Deliberately NOT
  // cleared afterwards: both networks count a click for every purchase inside its window, so the
  // same landing may legitimately claim a second order days later.
  const attribution = readAttribution(cookies);

  const orderIds: string[] = [];
  const createdOrders: Order[] = [];
  // Flips the moment the CAPTURE succeeds — not when the order rows are written, which is what it
  // used to mean and is no longer the same instant (lib/payment.ts: authorize → order → capture).
  // It is what the catch below reads.
  // Before it: a throw means no purchase happened. The stock goes back and the hold is released,
  // so the buyer is left owing nothing.
  // After it: the money is really taken and the orders are real, so restocking would put sold
  // units back on the shelf and oversell them — a failure in the trailing steps (clearing the
  // cart, analytics, confirmation mail) is not grounds for undoing a completed purchase.
  let committed = false;
  // The HOLD, kept outside the try so the catch can release it. This is the variable that makes
  // "the buyer's money is committed to us and the order is not" a state the code can see; before
  // 2026-08-07 the charge was a `const` inside the try and the catch could not know money had moved.
  let held: { paymentRef: string; amountAgorot: number } | null = null;

  try {
    // ── Step 1 of 3: AUTHORIZE. Holds the money, takes nothing. ──
    // The owner's rule (2026-08-07): an order may exist only if money was really taken, and money
    // may be taken only if the order really exists. No transaction spans a payment gateway and our
    // database, so the only way to have both is to make the FIRST step reversible and the
    // irreversible one LAST — hold here, write the orders, and capture at step 3. lib/payment.ts's
    // header carries the full argument and the failure table.
    // Through `storeSliceTotalAgorot`, not inline: it is THE definition of what one store's slice
    // came to, and every surface that shows an order total already reads it. An inline
    // `subtotal + shipping` here is the shape that drifted from it three times before
    // (tests/order-total-single-source.test.ts fails on a new one).
    const grandTotalAgorot = Object.values(storeSubtotals).reduce((sum, d) => sum + storeSliceTotalAgorot(d), 0);
    // The key travels to the provider too, so the gateway's OWN de-duplication backs
    // up ours: if our ledger write is lost between authorizing and recording, the retry
    // still reaches a provider that recognises the key and refuses to hold twice.
    // The provider is handed ILS, because that is the unit a payment gateway's API speaks and the
    // unit the buyer's statement will show. This is a render/hand-off boundary, exactly like the
    // screen: `fromAgorot` once, at the edge, off an integer that is already exact.
    const payment = await paymentProvider.authorize({ amount: fromAgorot(grandTotalAgorot), checkoutRef, buyerEmail: buyerData.buyerEmail, idempotencyKey });
    // Journalled whether it succeeded or failed — a decline is exactly the kind of
    // event that is invisible afterwards (no order row is left behind to show it
    // happened) and exactly what someone asks about later.
    await recordMoneyEvent({
      type: 'payment_attempted',
      checkoutRef,
      amountAgorot: grandTotalAgorot,
      actor: 'buyer',
      detail: payment.ok ? `authorized ref=${payment.paymentRef ?? '—'}` : `declined: ${payment.error ?? 'unknown'}`,
    });
    if (!payment.ok) return abort({ error: payment.error ?? 'התשלום נכשל' }, 402);
    // Recorded the instant the hold is known to exist, and before anything that can throw. A
    // provider that approves without returning a reference leaves this null: we cannot release a
    // hold we cannot name, and the catch says so out loud rather than pretending otherwise.
    if (payment.paymentRef) held = { paymentRef: payment.paymentRef, amountAgorot: grandTotalAgorot };

    // Create one order per store so each seller owns a separate, isolated order
    // ── Step 2 of 3: the order rows. Still 'pending' — no money has moved yet. ──
    // Written as pending rather than paid because at this instant it is simply TRUE: the gateway is
    // holding the amount and has not been told to take it. Writing 'paid' here is the lie the old
    // flow told, and every revenue sum, seller balance and payout would have been computed from it
    // for an order whose capture had not been attempted.
    for (const [storeSlug, sub] of Object.entries(storeSubtotals)) {
      const storeItems = orderItems.filter((i) => i.storeSlug === storeSlug);
      const storeTotalAgorot = storeSliceTotalAgorot(sub);
      const storeOrder = await createOrder({
        ...buyerData,
        checkoutRef,
        paymentStatus: 'pending',
        paymentRef: payment.paymentRef,
        items: storeItems,
        storeSubtotals: { [storeSlug]: sub },
        shippingAgorot: sub.shippingAgorot,
        totalAgorot:    storeTotalAgorot,
        ...(attribution ? { attribution } : {}),
      });
      orderIds.push(storeOrder.id);
      createdOrders.push(storeOrder);
      await recordMoneyEvent({
        type: 'order_created',
        orderId: storeOrder.id,
        checkoutRef,
        storeSlug,
        amountAgorot: storeTotalAgorot,
        to: 'pending',
        actor: 'buyer',
        detail: `${storeItems.length} item(s); authorized ref=${payment.paymentRef ?? '—'}`,
      });
    }

    // ── Step 3 of 3: CAPTURE. The irreversible step, and the orders provably exist. ──
    // A failure here is the one remaining bad window, and it is now a HARMLESS one: the hold is
    // released, the orders that were written are marked failed and cancelled, and their stock goes
    // back. The rows survive rather than being deleted — a money record is evidence, and "an
    // attempted purchase that could not be paid for" is exactly the thing someone asks about — but
    // nothing is shippable, nothing counts as revenue (order-status-rules.ts), and no seller is
    // told about it, because the seller notifications are below this point and not above it.
    const capture = await paymentProvider.capture({
      paymentRef: payment.paymentRef ?? '',
      idempotencyKey,
      amount: fromAgorot(grandTotalAgorot),
    });
    if (!capture.ok) {
      await failCapture(orderIds, checkoutRef, grandTotalAgorot, capture.error);
      // `held` is cleared only after the void so the catch below cannot double-release it.
      if (held) { await voidRefund(held, checkoutRef, idempotencyKey, capture.error ?? 'capture failed'); held = null; }
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      for (const id of couponClaims) await releaseCoupon(id);
      await releaseCheckout(idempotencyKey);
      return json({ error: capture.error ?? 'החיוב נכשל. לא בוצע חיוב — אפשר לנסות שוב.' }, 402);
    }

    // The money is now really taken and the orders really exist. Both halves of the owner's rule
    // hold from this line onward, and `committed` is what tells the catch below never to undo it.
    committed = true;
    held = null;
    await markOrdersPaid(orderIds, checkoutRef, payment.paymentRef);
    // Record the key's result before anything else can throw, so a retry replays these orders
    // instead of buying them again.
    await completeCheckout(idempotencyKey, checkoutRef, orderIds, owner);

    // Sellers are told only now — after the money is real. A "הזמנה חדשה!" for a purchase whose
    // capture then failed is the notification that makes a seller pack a parcel for nothing.
    for (const storeOrder of createdOrders) {
      const storeSlug = storeOrder.items[0]?.storeSlug ?? '';
      const store = storeSlug ? await getStoreBySlug(storeSlug) : null;
      if (!store) continue;
      // Swallowed on failure, deliberately: the money and the order row are already committed by
      // the time this runs, so a database hiccup here must not turn a completed purchase into a
      // 500 for the buyer. The seller's dashboard shows the order either way; only the badge is
      // at stake.
      //
      // **But it is no longer swallowed SILENTLY, and that was the gap.** "The capture succeeded
      // and the seller was never told" produced nothing anywhere — no log line, no alert, and a
      // seller who does not open their dashboard has a paid order sitting unshipped with the one
      // thing that would have prompted them missing. Reported at `warning`: the sale stands and
      // nothing is owed to anyone, so it must not page a person (lib/error-severity.ts), but it
      // must be findable in the Alerts tab beside the order it belongs to.
      await createNotification({
        userId: store.sellerId,
        role: 'seller',
        type: 'new_order',
        title: 'הזמנה חדשה!',
        body: `הזמנה מ-${buyerData.buyerName} על סך ${formatAgorot(storeOrder.totalAgorot)}`,
        relatedId: storeOrder.id,
        storeSlug: store.slug,
        storeName: store.name,
      }).catch((err: unknown) => {
        void logError({
          source: 'server',
          // Named for what actually failed, not for the handler it ran inside, and that decides how
          // loudly it is reported: `/api/checkout` is a MONEY path, so an entry under it pages a
          // person (error-severity.ts) — which is the right answer for a checkout that broke and
          // the wrong one for a checkout that succeeded and then failed to ring a bell. An alert
          // channel that wakes someone for a badge is a channel that gets muted. Severity is not
          // passed: it is derived, exactly so this decision is made in one place and by the route.
          route: 'notify:new_order',
          message: `new-order notification failed for order ${storeOrder.id}: ${err instanceof Error ? err.message : String(err)}`,
          storeSlug: store.slug,
          storeName: store.name,
          actorRole: 'seller',
          actorId: store.sellerId,
          resolutionHint: 'התשלום נגבה וההזמנה קיימת — רק ההתראה למוכר נכשלה. ההזמנה מופיעה בדשבורד שלו, אבל בלי התראה הוא עלול לא לשים לב אליה. שווה ליידע אותו ידנית.',
        });
      });
    }

    for (const alert of stockAlerts) {
      const label = describeStockAlertProduct(alert.productName, alert.selectedVariants);
      await createNotification({
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
      }).catch((err: unknown) => {
        // Same reason as the new-order notification above: the purchase is already committed, so
        // this must not fail it — and must not disappear either. A seller who is never told a
        // product ran out is a seller who does not restock it.
        void logError({
          source: 'server',
          route: 'notify:stock_alert',
          message: `${alert.type} notification failed for product ${alert.productId}: ${err instanceof Error ? err.message : String(err)}`,
          storeSlug: alert.storeSlug,
          storeName: alert.storeName,
          actorRole: 'seller',
          actorId: alert.sellerId,
          resolutionHint: 'ההזמנה והתשלום תקינים — רק ההתראה על המלאי למוכר נכשלה. המלאי בדשבורד שלו נכון; ייתכן שלא ישים לב שהמוצר אזל.',
        });
      });
    }

    // Remove only the purchased lines from the server-side cart (the buyer may have left other
    // items unselected at checkout). It is a DELETE of exactly those rows now, so nothing else the
    // buyer owns is even named by the statement — the shape this replaces rebuilt the whole cart
    // object and handed back every other field with it, and the one it forgot to hand back
    // (`recentStores`) was quietly emptied by every purchase.
    if (userId) {
      const purchased: CartLineRef[] = items.map((raw) => {
        const item = raw as CartItemInput;
        const selectedVariants =
          item.selectedVariants && typeof item.selectedVariants === 'object' && !Array.isArray(item.selectedVariants)
            ? (item.selectedVariants as Record<string, string>)
            : undefined;
        return {
          storeSlug: typeof item.storeSlug === 'string' ? item.storeSlug.trim() : '',
          cartKey: makeCartKey(typeof item.productSlug === 'string' ? item.productSlug.trim() : '', selectedVariants),
        };
      });
      // NOT given a `.catch()` of its own, unlike the notification above, and the difference is
      // the point: `committed` is already true here, so the outer handler answers 201 anyway AND
      // records the failure with the resolution hint that names this step. Swallowing it here
      // would buy the same status code at the cost of the only trace anyone would have.
      await removeCartLines(userId, purchased);
    }

    // First-party funnel: the purchase stage. Recorded server-side after the
    // order commits (never client-side) so an ad-blocker or a closed tab can't
    // drop it; the sn_vid session ties it back to this shopper's earlier
    // add_to_cart for the cart-abandonment math. Fire-and-forget, never throws.
    void recordAnalyticsEvent('purchase', {
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
    // ── Give the money back before anything else ──
    // Reached only when the charge SUCCEEDED and the purchase then did not. It is the first thing
    // in this handler because it is the only part of the failure that costs a real person real
    // money: the stock is ours to restore whenever, the log can wait a tick, a held charge cannot.
    //
    // `voidRefund` never throws — a compensation that can itself throw would skip the restock and
    // the logging below and turn one bad outcome into three. Its own failure is captured and
    // reported, because "we could not give it back" is precisely the case a person must handle by
    // hand, and it is the one that must never be silent.
    let voidOutcome: 'none' | 'voided' | 'void-failed' = 'none';
    if (held && !committed) {
      voidOutcome = await voidRefund(held, checkoutRef, idempotencyKey, err);
    }
    if (!committed) {
      for (const d of decremented) await restockProduct(d.productId, d.qty, d.selectedVariants);
      // Same rule as the stock: a purchase that did not happen consumed nothing. Never above the
      // `committed` line — a completed order's coupon use is spent, and giving it back would let
      // one buyer redeem a one-per-store code twice.
      for (const id of couponClaims) await releaseCoupon(id);
      await releaseCheckout(idempotencyKey);
    }
    const storeSlugs = Object.keys(storeSubtotals);
    void logError({
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
      // The cart rides along on the hint because that is the field a person reads, and because the
      // alert mail and the dashboard's copy button both already surface it verbatim. Capped: a bulk
      // cart must not push the useful sentence past the column's 500-character clamp.
      // Addressed to WHOEVER READS IT, and that is only ever the operator: `resolutionHint`
      // surfaces in exactly two places — the admin Alerts tab and the ALERT_EMAIL critical mail
      // (lib/critical-alert.ts). The buyer never sees it (they get the generic 500 body below) and
      // the seller never sees it (a failed checkout creates no order, so nothing reaches their
      // dashboard and no notification fires). Until 2026-08-07 the un-committed branch read "try
      // the order again — if it repeats, contact support with the reference number", which is
      // advice for a customer, printed on a screen no customer can open. What the operator needs
      // instead is what is now owed: nobody else knows this happened, and the charge runs BEFORE
      // the order rows, so a real gateway can be holding money with no order behind it.
      resolutionHint: [
        committed
          ? 'ההזמנה נוצרה והתשלום עבר; הכשל היה בשלב שאחרי (ניקוי עגלה / מייל אישור). אין לבטל את ההזמנה — יש לבדוק שהמייל נשלח.'
          : 'לא נוצרה הזמנה; המלאי שוחזר אוטומטית. הקונה ראה שגיאה כללית ולא יקבל שום עדכון נוסף, והמוכר אינו מיודע — כל פנייה אליהם היא ידנית.',
        // What happened to the buyer's money, stated first among the details because it is the
        // only line here that can require someone to act today.
        committed ? '' :
          voidOutcome === 'voided' ? 'לא בוצע חיוב: ההחזקה על הכרטיס שוחררה אוטומטית. אין צורך בהחזר ידני.'
          : voidOutcome === 'void-failed' ? '‼️ ההחזקה על כרטיס הקונה לא שוחררה, ואין מולה הזמנה. נדרשת פעולה ידנית מול ספק הסליקה לפי מספר האסמכתא ביומן הכספי.'
          : 'לא בוצעה החזקה על הכרטיס (או שהספק לא החזיר מספר עסקה), כך שאין מה לשחרר — הקונה לא חויב.',
        attempted.length
          ? `בעגלה: ${attempted.slice(0, 8).join(', ')}${attempted.length > 8 ? ` ועוד ${attempted.length - 8}` : ''}.`
          : '',
      ].filter(Boolean).join(' '),
    });
    // A post-commit failure still returns the successful response: the buyer paid
    // and the orders exist, so sending them an error would invite exactly the
    // duplicate purchase this endpoint now guards against.
    if (committed) return json({ orderIds, checkoutRef }, 201);
    return json({ error: 'Checkout failed, please try again' }, 500);
  }
}
