export const prerender = false;
import crypto from 'node:crypto';
import type { APIContext } from 'astro';
import { getStoreBySlug, getStoreBySlugOrPrevious, canStoreSell } from '../../lib/stores.js';
import { isDemoStore } from '../../lib/demo-stores.js';
import { isSharedDemoSeller } from '../../lib/demo-viewer.js';
import { getProductBySlug, decrementStock, restockProduct, LOW_STOCK_THRESHOLD, isProductVisible } from '../../lib/store-products.js';
import { createOrder, updateOrder } from '../../lib/orders.js';
import type { Order, OrderItem, StoreSubtotal } from '../../lib/orders.js';
import { paymentProvider } from '../../lib/payment.js';
import { normalizeDeliveryMethod, shippingPrice, offersSelfPickup } from '../../lib/shipping.js';
import { sendOrderConfirmationEmails } from '../../lib/email/order-confirmation.js';
import { createNotification } from '../../lib/notifications.js';
import { getSellerByEmail, getSellerSession } from '../../lib/seller-auth.js';
import { merchantBlockFor } from '../../lib/seller-merchant.js';
import { removeCartLines, type CartLineRef } from '../../lib/user-carts.js';
import { isValidEmail } from '../../lib/email-address.js';
import { makeCartKey } from '../../lib/cart.js';
import { resolveSelection } from '../../lib/variant-combo.js';
import { logError } from '../../lib/error-log.js';
import { recordAnalyticsEvent } from '../../lib/analytics.js';
import { effectivePrice } from '../../lib/discounts.js';
import { claimCheckout, completeCheckout, releaseCheckout, isValidIdempotencyKey, checkoutOwner } from '../../lib/checkout-idempotency.js';
import { recordMoneyEvent } from '../../lib/money-events.js';
import { commissionMismatch, commissionMismatchDetail } from '../../lib/commission-check.js';
import { heCount } from '../../lib/he-count.js';
import { storeSliceGoodsAgorot, storeSliceTotalAgorot } from '../../lib/order-totals.js';
import { toAgorot, fromAgorot, formatAgorot } from '../../lib/money.js';
import { readJsonBody, BODY_LIMIT } from '../../lib/request-body.js';
import { checkoutClosedReason } from '../../lib/site-mode.js';
import { readAttribution } from '../../lib/attribution.js';
import { getCouponByCode, claimCoupon, releaseCoupon } from '../../lib/store-coupons.js';
import { checkCoupon, normalizeCouponCode } from '../../lib/coupons.js';
import { planBuyerInvoice } from '../../lib/invoicing/index.js';
import { getSellerById } from '../../lib/seller-auth.js';
import { merchantAccountsFor } from '../../lib/seller-merchant.js';
import { activePaymeCredentials, captureBuyerToken, type PaymeCredentials } from '../../lib/payment-payme.js';
import { isDemoMode } from '../../lib/demo-mode.js';
import { planSplit, authorizeCart, captureSlices, type SplitInput, type SplitPlan } from '../../lib/payment-split.js';
import { commissionOnAgorot, commissionPercentForTier, feeWithVatPercent, DEFAULT_TIER } from '../../lib/pricing.js';
import { chargedCommissionPercentForStore } from '../../lib/store-plan.js';
import { store as platform } from '../../config/store.config.js';

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
  /**
   * The buyer's PayMe token, from Hosted Fields — one card entry for the whole cart, charged once
   * per store (`lib/payment-split.ts`).
   *
   * **Not a secret arriving from a client in the dangerous sense, and not a permission either.** It
   * names a card PayMe hold; it does not say whose cart this is, and nothing here treats it as
   * proof of anything. What it CAN do if it were somebody else's is charge the wrong person, which
   * is why the token is minted against this browser's own card entry and never persisted anywhere
   * a second buyer could read it.
   *
   * Required only when PayMe are configured. Absent on the mock path, which is dev and the
   * pre-gateway window GO_LIVE §7 plans.
   */
  buyerKey?: unknown;
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
    detail: `החיוב נכשל (${error ?? 'סיבה לא ידועה'}) — ${heCount(orderIds.length, 'הזמנה', 'הזמנות')} בוטלו והמלאי הוחזר`,
  }).catch(() => { /* the endpoint's own logError still fires */ });
}

/**
 * The N+1 charges of a split checkout, wearing the same shape as a capture.
 *
 * Adapting rather than branching the handler: everything downstream of "did the money move" — the
 * order rows, the notifications, the invoices, the compensation — is identical whichever provider
 * took it, and a second copy of that sequence is how two paths drift.
 *
 * **Never throws.** `chargeSplit` already unwinds what it charged; this adds the journal, which is
 * the independent record a reconciliation reads, and the alert for the one outcome a person has to
 * act on: a charge that could not be given back.
 */
async function chargeSplitAsCapture(
  authorizationId: string,
  input: SplitInput,
  plan: SplitPlan,
  creds: PaymeCredentials,
  checkoutRef: string,
): Promise<{ ok: boolean; error?: string; refsByStore?: Map<string, string> }> {
  const result = await captureSlices(authorizationId, input, plan, creds);

  if (result.ok) {
    // One row per capture, because there IS one per store — the journal's job is to be an
    // independent record of what happened at the provider, and collapsing N transactions into one
    // entry would make it impossible to reconcile against PayMe's own statement. The delivery part
    // is named on the row it rode in on, since it is no longer a transaction of its own.
    for (const leg of result.captures) {
      // **Our commission, against theirs** (area audit row 13). The percent is sent per sale, so
      // the two should agree — and they can stop agreeing without anyone touching this repository:
      // PayMe hold a default fee per merchant, it can be changed at their end, and a future code
      // path that forgets to send the tier's rate falls back to whatever they have stored. Until
      // now their figure came back on every capture and was dropped, so that drift would have been
      // invisible on both sides. `commission-check.ts` carries the rounding tolerance and why it is
      // one agora.
      const mismatch = commissionMismatch(
        commissionOnAgorot(leg.amountAgorot, leg.marketFeePercent),
        leg.marketFeeTotalAgorot,
      );
      if (mismatch) {
        const line = commissionMismatchDetail(mismatch, leg.storeSlug ?? '—', leg.paymeSaleId);
        // BOTH, and they are different audiences: the journal is where the money is reconciled
        // months later, the error log is what a person reads this week. Neither is allowed to fail
        // the purchase — the buyer paid, the seller was paid, and the disagreement is about our own
        // cut.
        await recordMoneyEvent({
          type: 'payment_attempted',
          checkoutRef,
          ...(leg.storeSlug ? { storeSlug: leg.storeSlug } : {}),
          amountAgorot: mismatch.actualAgorot,
          from: 'commission-expected',
          to: String(mismatch.expectedAgorot),
          actor: 'system',
          detail: line,
        }).catch(() => { /* the log below still reports it */ });
        await logError({
          source: 'server',
          route: '/api/checkout',
          message: line,
          resolutionHint: 'העמלה שגבו PayMe שונה מזו שהמסלול של המוכר מגדיר. ייתכן שעמלת ברירת המחדל אצלם על בית העסק שונה ממה שאנחנו שולחים, או שמסלול שהשתנה אצלנו לא נשלח. הפרש שחוזר על עצמו הוא כסף אמיתי בכל מכירה.',
        }).catch(() => { /* nothing left to try */ });
      }
      await recordMoneyEvent({
        type: 'payment_attempted',
        checkoutRef,
        ...(leg.storeSlug ? { storeSlug: leg.storeSlug } : {}),
        amountAgorot: leg.amountAgorot,
        // **The delivery capture's reference has nowhere else to live** (GO_LIVE §3.1.2). Each
        // store's capture id lands on its own order row; the delivery leg belongs to the CART and
        // not to any one store, so no order can hold it — and without it a refund of a delivery fee
        // has nothing to call PayMe with. These two columns are free text and the panel renders
        // them beside the sentence, so the id is machine-readable here instead of being parsed back
        // out of Hebrew prose (`lib/refund-execute.ts#deliveryCaptureRef`).
        from: leg.kind,
        to: leg.paymeSaleId,
        actor: 'buyer',
        detail: `\u05e0\u05d2\u05d1\u05d4 \u00b7 ${leg.kind === 'delivery' ? '\u05de\u05e9\u05dc\u05d5\u05d7 (\u05d4\u05d7\u05e9\u05d1\u05d5\u05df \u05e9\u05dc\u05e0\u05d5)' : `\u05d7\u05e0\u05d5\u05ea ${leg.storeSlug}`} \u00b7 \u05d0\u05e1\u05de\u05db\u05ea\u05d4 ${leg.paymeSaleId}`,
      }).catch(() => { /* the order rows below are still written; a lost journal row is not a lost sale */ });
    }
    const refsByStore = new Map<string, string>();
    for (const c of result.captures) if (c.storeSlug) refsByStore.set(c.storeSlug, c.paymeSaleId);
    return { ok: true, refsByStore };
  }

  await recordMoneyEvent({
    type: 'payment_attempted',
    checkoutRef,
    actor: 'buyer',
    detail: `\u05e0\u05d3\u05d7\u05d4 \u00b7 ${result.detail.slice(0, 200)}${result.voided ? ' \u00b7 \u05d4\u05d4\u05d7\u05d6\u05e7\u05d4 \u05e9\u05d5\u05d7\u05e8\u05e8\u05d4' : ''}`,
  }).catch(() => { /* the logError below still reports the whole failure */ });

  // Every capture that was given back. `charge_voided` is exactly this word's definition: money
  // moved, the purchase behind it did not, and it went back.
  for (const leg of result.refunded) {
    await recordMoneyEvent({
      type: 'charge_voided',
      checkoutRef,
      ...(leg.storeSlug ? { storeSlug: leg.storeSlug } : {}),
      amountAgorot: leg.amountAgorot,
      actor: 'buyer',
      detail: `\u05d4\u05d5\u05d7\u05d6\u05e8 \u05d1\u05de\u05dc\u05d5\u05d0\u05d5 \u00b7 \u05d0\u05e1\u05de\u05db\u05ea\u05d4 ${leg.paymeSaleId}`,
    }).catch(() => { /* reported in aggregate below */ });
  }

  // AND the ones that were not. Journalled BEFORE the alert, where nothing can drop them: this is
  // money a real person paid for an order that does not exist.
  for (const failed of result.unrefunded) {
    await recordMoneyEvent({
      type: 'charge_voided',
      checkoutRef,
      ...(failed.leg.storeSlug ? { storeSlug: failed.leg.storeSlug } : {}),
      amountAgorot: failed.leg.amountAgorot,
      actor: 'buyer',
      detail: `\u203c\ufe0f \u05d4\u05d4\u05d7\u05d6\u05e8 \u05e0\u05db\u05e9\u05dc \u00b7 \u05d0\u05e1\u05de\u05db\u05ea\u05d4 ${failed.leg.paymeSaleId} \u00b7 ${failed.error.slice(0, 160)}`,
    }).catch(() => { /* the logError below still reports it */ });
  }
  if (result.unrefunded.length) {
    await logError({
      source: 'server',
      route: '/api/checkout',
      message: `split capture failed and ${result.unrefunded.length} capture(s) could not be refunded: ${result.unrefunded.map((u) => `${u.leg.paymeSaleId} (${u.error})`).join('; ')}`,
      statusCode: 500,
      actorRole: 'buyer',
      resolutionHint: '\u203c\ufe0f \u05d4\u05e7\u05d5\u05e0\u05d4 \u05d7\u05d5\u05d9\u05d1 \u05e2\u05dc \u05d4\u05d6\u05de\u05e0\u05d4 \u05e9\u05dc\u05d0 \u05e0\u05d5\u05e6\u05e8\u05d4, \u05d5\u05d4\u05d4\u05d7\u05d6\u05e8 \u05d4\u05d0\u05d5\u05d8\u05d5\u05de\u05d8\u05d9 \u05e0\u05db\u05e9\u05dc. \u05e6\u05e8\u05d9\u05da \u05dc\u05d1\u05e6\u05e2 refund \u05d9\u05d3\u05e0\u05d9 \u05d1-PayMe \u05dc\u05e4\u05d9 \u05de\u05e1\u05e4\u05e8\u05d9 \u05d4\u05d0\u05e1\u05de\u05db\u05ea\u05d0 \u05d1\u05d9\u05d5\u05de\u05df \u05d4\u05db\u05e1\u05e4\u05d9.',
    }).catch(() => { /* nothing left to try */ });
  }

  return { ok: false, error: '\u05d4\u05ea\u05e9\u05dc\u05d5\u05dd \u05e0\u05d3\u05d7\u05d4. \u05dc\u05d0 \u05e0\u05d2\u05d1\u05d4 \u05de\u05de\u05da \u05d3\u05d1\u05e8 \u2014 \u05d0\u05e4\u05e9\u05e8 \u05dc\u05e0\u05e1\u05d5\u05ea \u05db\u05e8\u05d8\u05d9\u05e1 \u05d0\u05d7\u05e8.' };
}

/** The orders were written pending and the capture has now succeeded. This is the ONLY place a
 *  checkout marks an order paid, and it runs strictly after the money moved.
 *
 *  `refsByStore` is the split path's per-store sale id. A single `paymentRef` is right when there
 *  was one transaction; under the split there are N+1, and a refund names exactly one of them —
 *  so each order carries the reference to ITS OWN charge and not a shared one. */
async function markOrdersPaid(
  orders: readonly Order[],
  checkoutRef: string,
  paymentRef?: string,
  refsByStore?: Map<string, string>,
): Promise<void> {
  const orderIds = orders.map((o) => o.id);
  for (const order of orders) {
    // Bound to a local `id` rather than passed as `order.id`, and that is not a style choice:
    // `tests/seller-orders-scope.test.ts` reads this file and asserts that every `updateOrder` in
    // it names a local id, which is how it proves checkout never mutates an order named by a
    // request. Keeping the shape keeps the guard narrow instead of widening its allowlist.
    const id = order.id;
    const storeSlug = order.items[0]?.storeSlug ?? '';
    const ref = refsByStore?.get(storeSlug) ?? paymentRef;
    await updateOrder(id, { paymentStatus: 'paid', ...(ref ? { paymentRef: ref } : {}) });
  }
  await recordMoneyEvent({
    type: 'payment_status_changed',
    checkoutRef,
    to: 'paid',
    actor: 'buyer',
    detail: `הכסף נגבה בפועל · אסמכתת סליקה ${paymentRef ?? '—'} · ${heCount(orderIds.length, 'הזמנה', 'הזמנות')}`,
  });
}

export async function POST({ request, cookies }: APIContext): Promise<Response> {
  // FIRST, before the body is even read. The platform goes onto its real domain weeks before a
  // payment gateway exists (GO_LIVE §7), and until one does, every path below would hand out real
  // orders and real stock for nothing — `MockPaymentProvider.authorize()` approves everything.
  // Not a hidden button and not a flag someone has to remember: `lib/site-mode.ts` derives this
  // from what the payment provider actually is, so wiring the real one opens the shop by itself.
  const closed = checkoutClosedReason();
  if (closed) return json({ error: 'store-closed', reason: closed }, 503);

  const read = await readJsonBody<CheckoutBody>(request, BODY_LIMIT.collection);
  if (!read.ok) return json({ error: read.status === 413 ? 'Body too large' : 'Invalid JSON body' }, read.status);
  const body = read.value;

  const { buyerName, buyerEmail, buyerPhone, buyerAddress, items, deliveryMethods, coupons, idempotencyKey, buyerKey } = body;

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
  // for whom an accidental sale is expensive — stock, commission and mail all move. The address he
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

  // Pre-pass guards, each refusing the whole checkout before the loop below reserves any
  // stock — all are static properties of the store, so none needs a rollback path.
  const merchantChecked = new Set<string>();
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
    // that matters — stock, commission, mail, and the units that drive the `popular`/
    // `bestseller` label in the Google/Meta feed — so a curious click around his own
    // storefront must not create one.
    // The storefront also refuses this client-side (lib/own-store-guard.ts), but a
    // hidden button is not a rule: the cart is client state and this endpoint is
    // directly callable. This is the guarantee; that is only the explanation.
    //
    // Buying from ANOTHER seller's store is untouched by this — the rule is about his own.
    // …with ONE narrowing, and it is an account rather than a rule: the demonstration's shared
    // seller owns every showcase shop, so this refusal made the whole demo unbuyable for a
    // visitor who had looked at the dashboard (`lib/demo-viewer.ts#isSharedDemoSeller`).
    if (buyerSellerIds.has(preStore.sellerId) && !(await isSharedDemoSeller(preStore.sellerId))) {
      return json({ error: 'own-store' }, 403);
    }
    // **No clearing account, no sale.** Under the split model the buyer's money goes straight into
    // the SELLER's own merchant account (`lib/seller-merchant.ts`), so a seller who has not opened
    // one has nowhere for it to land. Taking the order anyway would mean either holding his money —
    // which is the whole thing this model exists to avoid, and carries the licensing exposure that
    // came with it — or handing over goods for nothing.
    //
    // Refused here in the pre-pass, before a single unit of stock is reserved, for the same reason
    // the two guards above are: it is a static property of the store, so there is nothing to roll
    // back. `payment-split.ts#planSplit` refuses the same case again at charge time; this one is
    // what stops the buyer getting as far as a payment page.
    //
    // Returns null when no gateway is configured, so dev and the pre-gateway window GO_LIVE §7
    // plans are untouched — what guards THAT window is `site-mode.ts`, which is stricter still.
    //
    // Once per SELLER and not once per item: a ten-line cart from one shop asks one question.
    if (!merchantChecked.has(preStore.sellerId)) {
      merchantChecked.add(preStore.sellerId);
      const merchantBlock = await merchantBlockFor(preStore.sellerId);
      if (merchantBlock) return json({ error: 'store-cannot-sell', reason: merchantBlock }, 409);
    }
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
      detail: `מפתח תשלום של קונה אחד הוצג על ידי קונה אחר; נחסם (מפתח ${keyForLog})`,
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
      detail: `שליחה חוזרת של אותו תשלום — הוחזרו ${claim.record.orderIds?.length ?? 0} ההזמנות הקיימות במקום לחייב שוב (מפתח ${keyForLog})`,
    });
    return json({ orderIds: claim.record.orderIds ?? [], checkoutRef: claim.record.checkoutRef, replayed: true });
  }
  if (claim.status === 'in_progress') {
    // The first attempt is still at the gateway. Refusing is the safe answer: we
    // cannot know yet whether it will charge, so we must not start a second one.
    await recordMoneyEvent({
      type: 'duplicate_checkout_blocked',
      actor: 'buyer',
      detail: `אותו תשלום נשלח פעמיים במקביל; השני נחסם (מפתח ${keyForLog})`,
    });
    return json({ error: 'checkout-in-progress' }, 409);
  }

  const orderItems: OrderItem[] = [];
  const storeSubtotals: Record<string, StoreSubtotal> = {};
  /** Store slug → the seller whose merchant account its share is charged to. */
  const storeSellers = new Map<string, string>();
  /** Store slug → the commission percent THIS store's plan carries (`lib/store-plan.ts`). Per
   *  store since 2026-08-24: a plan is bought per shop, so the rate belongs to the shop and not to
   *  the account that happens to own it. A cart holding two shops of the same seller on two plans
   *  is charged two different rates, which is the point of selling them separately. */
  const storeCommission = new Map<string, number>();
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

    // The variant selection is re-derived from the PRODUCT, exactly like the price two blocks
    // down, and for the same reason: it decides which stock bucket the sale comes out of, so a
    // selection nobody checked is a selection the buyer chose. Refusing an unrecognised one is
    // what keeps "no bucket matched" meaning "this combo sells from the shared pool" instead of
    // also meaning "this combo does not exist" — the ambiguity that let a hand-posted checkout
    // buy against a fully-counted product's total. `lib/variant-combo.ts#resolveSelection` has
    // the whole finding; `tests/variant-selection-guard.test.ts` keeps this call site honest.
    const resolved = resolveSelection(product.variants, item.selectedVariants);
    if (!resolved.ok) {
      // A machine code rather than prose, because the ONE way a real buyer reaches this is a cart
      // line that predates the seller editing the product's variants — and "Invalid variant
      // selection" in English, in the error line, is a dead end for them. The page turns this into
      // a sentence naming the product and asking them to pick it again.
      return abort({ error: 'variant-mismatch', productName: product.name }, 400);
    }
    const selectedVariants = resolved.selection;

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
    // Whose merchant account this store's money goes into. Recorded here, off the store row this
    // loop already has, rather than re-fetched later: under the split model every slice is charged
    // to a DIFFERENT account, so "which seller owns this slug" stops being a reporting detail and
    // becomes the routing of real money.
    storeSellers.set(store.slug, store.sellerId);
    // Off the store row this loop already holds. It used to be a `getSellerById` per seller further
    // down, which was both a second source for the rate and a serial round trip on the one request
    // a buyer is watching a spinner through.
    //
    // **The CHARGED rate, not the quoted one** (2026-08-26). `market_fee` is what PayMe really
    // deduct from the seller's sale, and our commission is a B2B fee quoted before VAT
    // (`pricing.ts`), so the tax rides inside the same deduction: 12% quoted is 14.16% taken. The
    // platform's own income keeps the quoted rate — `commissionPercentForStore` — and mixing the
    // two would overstate our revenue by exactly the VAT we are collecting for the state.
    storeCommission.set(store.slug, chargedCommissionPercentForStore(store));
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
    const method = normalizeDeliveryMethod(clientMethods[storeSlug], offersSelfPickup(store));
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

  // ── The split plan: every refusal PayMe would give us, answered BEFORE any money moves ──
  //
  // Null when PayMe are not configured, and the mock authorize→capture path below runs unchanged.
  // That is dev, and the window GO_LIVE §7 plans between the domain going live and a gateway
  // existing — `site-mode.ts` is what refuses to sell at all in production during it.
  //
  // Here rather than after the orders are written, because these refusals are wholly knowable from
  // the numbers already in hand. Discovering "this store's slice is ₪4, below PayMe's minimum" one
  // charge later would mean a completed charge on a real card that has to be unwound, for a
  // condition we could have named a moment earlier.
  const paymeCreds = activePaymeCredentials();
  let splitInput: SplitInput | null = null;
  let splitPlan: SplitPlan | null = null;
  if (paymeCreds) {
    // The permanent buyer token, from Hosted Fields — the buyer typed a card once, on PayMe's own
    // field, so no card number ever reaches this process. Its absence is a 400 and not a decline:
    // there is nothing to charge and nothing was attempted.
    // Length-capped, not pattern-matched. Their own example is
    // `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`, but the format is theirs to change and a regex built
    // from one example would start refusing real tokens without warning. What must be bounded is
    // the SIZE: the body cap is 256KB, and without this a caller could push a quarter-megabyte
    // string straight into an outbound request to PayMe.
    // Unchanged for every real deployment: no token means nothing to charge, refused before any
    // work is done. The size cap applies to whatever the caller did send, demonstration or not.
    if (isString(buyerKey) && buyerKey.trim().length > 200) return abort({ error: 'missing-card' }, 400);
    if (!isString(buyerKey) && !isDemoMode()) return abort({ error: 'missing-card' }, 400);

    const accounts = await merchantAccountsFor([...storeSellers.values()]);

    /**
     * ── The demonstration's token (`lib/demo-mode.ts`) ──
     *
     * The demo collects no card — the panel where PayMe's iframes would be says so — so the browser
     * has no token to send, and the branch above is a 400 on every purchase. That is the one flow
     * the whole demonstration exists to show, and it would have failed on `missing-card`.
     *
     * The token is minted HERE rather than the split being skipped, and that is the important part.
     * Skipping it would mean the demonstration never runs `authorizeCart`, `captureSlices`, the
     * per-store market fee or the shipping leg — i.e. the entire payment architecture would be
     * absent from the thing built to demonstrate it. With a token, every one of those runs exactly
     * as in production; only the gateway answering them is local (`lib/payme-demo.ts`), which is
     * what `capture-buyer-token` returning a key from no card details means.
     *
     * `isDemoMode()` is asserted a second time rather than inferred from `!token`: this is the most
     * sensitive branch in the application, and a later edit that changes the guard above must not
     * silently turn this into a free checkout on a real deployment.
     */
    let token = isString(buyerKey) ? buyerKey.trim() : '';
    if (!token && isDemoMode()) {
      // Under any of the cart's merchants: a token created under one charges under any other, which
      // is the measured behaviour the whole one-card-many-stores design rests on (§3.1.1 item 2).
      const under = [...accounts.values()].find((a) => a.providerRef)?.providerRef;
      if (under) token = (await captureBuyerToken({ sellerPaymeId: under }, paymeCreds)).buyerKey;
    }
    if (!token) return abort({ error: 'missing-card' }, 400);

    splitInput = {
      buyerKey: token,
      stores: Object.entries(storeSubtotals).map(([storeSlug, sub]) => {
        const sellerId = storeSellers.get(storeSlug) ?? '';
        return {
          storeSlug,
          sellerPaymeId: accounts.get(sellerId)?.providerRef,
          // Goods minus the seller's order discount — NOT `storeSliceTotalAgorot`, which includes
          // shipping. The shipping part of that total is charged to us, on the separate leg below,
          // and folding it in here is precisely what breaches the 60% ceiling.
          //
          // Through `storeSliceGoodsAgorot` rather than spelled out, which also floors it at zero:
          // a corrupt row cannot hand a negative amount to a payment gateway, and `planSplit`'s
          // minimum still refuses the slice either way. Written inline first, and the tree scan in
          // `tests/order-total-single-source.test.ts` refused it — the same guard that exists
          // because five surfaces once computed `subtotal + shipping` by hand and three of them
          // dropped the discount.
          goodsAgorot: storeSliceGoodsAgorot(sub),
          // This store's delivery. Summed with the others into ONE capture to our own merchant
          // account, which is what keeps it out of the seller's 60% ceiling.
          shippingAgorot: sub.shippingAgorot,
          // The STORE's plan (`lib/store-plan.ts`), read off the row the item loop already had —
          // sent per sale rather than left to the merchant's stored default, so a plan change takes
          // effect on the next sale instead of needing a round trip to PayMe.
          // The DEFAULT plan's rate on a miss, never `0`. The two maps are filled in the same
          // loop from the same `store.slug`, so a miss cannot happen — but the fallback still has
          // to name a direction, and `?? 0` names "take no commission at all", silently, on a real
          // sale. Falling back to the entry plan is the same convention `resolveTier` applies to
          // every other unreadable plan value.
          marketFeePercent: storeCommission.get(storeSlug) ?? feeWithVatPercent(commissionPercentForTier(DEFAULT_TIER)),
          productName: `${sub.storeName} · ${checkoutRef}`,
        };
      }),
      // Our OWN merchant account — an ordinary one opened with `create-seller`, NOT the partner
      // id, which cannot receive money (174). `payment-split.ts` says why the distinction matters.
      // Off the CREDENTIALS rather than re-reading the variable they were built from. Same value in
      // production — `paymeCredentials()` fills `ownMerchantId` from exactly this environment
      // variable — and the difference is that the credentials are the one object that knows which
      // gateway this process is talking to. Re-reading the variable meant the portfolio
      // demonstration had no delivery merchant at all, so the shipping leg was refused on every
      // cart while the store legs charged, which is the shape of bug a second source always makes.
      deliveryMerchantId: paymeCreds.ownMerchantId,
      checkoutRef,
      buyerEmail: buyerData.buyerEmail,
      buyerName: buyerData.buyerName,
      // Named per sale rather than left to the merchant's stored default, so which URL PayMe post
      // to is a fact in this repository and not a setting in a panel nobody here can see. The
      // charge completes synchronously either way — the callback is corroboration, and
      // `/api/payme/callback` deliberately cannot move an order.
      callbackUrl: `${platform.url}/api/payme/callback`,
    };
    splitPlan = planSplit(splitInput);
    if (splitPlan.refusals.length) {
      // Journalled: a checkout refused before it was ever attempted leaves no order row behind it,
      // so without this it is invisible afterwards — and "why can nobody buy from that shop" is
      // exactly the question this answers.
      await recordMoneyEvent({
        type: 'payment_attempted',
        checkoutRef,
        actor: 'buyer',
        detail: `נדחה לפני חיוב: ${splitPlan.refusals.map((r) => ('storeSlug' in r ? `${r.reason} (${r.storeSlug})` : r.reason)).join(', ')}`,
      }).catch(() => { /* the abort still returns the reasons to the caller */ });
      return abort({ error: 'cannot-charge', refusals: splitPlan.refusals }, 409);
    }
  }
  // ── The conversion figure Google and Meta are handed (2026-08-23, CURRENT_TASK סשן ב׳ item 3) ──
  // The buyer's browser fires the `purchase` / `Purchase` event, and it must not compute the amount
  // itself: what the cart holds is a re-priced ESTIMATE, and a sale that ended between the re-price
  // and the charge would be reported above what was really taken. This is the charged figure, from
  // the same `storeSubtotals` the payment is derived from.
  //
  // **Goods only, shipping reported beside it and never inside it.** Under the split model the
  // carriage is charged to the platform's own merchant account and is nobody's sale
  // (`order-totals.ts#storeSliceGoodsAgorot`), so folding it into `value` would inflate every ROAS
  // the seller and the owner read by the shipping fee — most visibly on cheap items, where it is
  // the larger half. GA4 takes `shipping` as its own field for exactly this reason.
  //
  // Declared out here, beside `checkoutRef`, because the response is returned from three places and
  // one of them is the catch (a post-commit failure still returns 201 — the buyer paid).
  const conversion = {
    revenueAgorot: Object.values(storeSubtotals).reduce((sum, d) => sum + storeSliceGoodsAgorot(d), 0),
    shippingAgorot: Object.values(storeSubtotals).reduce((sum, d) => sum + d.shippingAgorot, 0),
  };

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
    //
    // **Under the split model there is no step 1, and that is not a weakening.** PayMe cannot hold
    // one authorization across N merchant accounts, so the reversible-first trick is a different
    // one: the buyer's TOKEN is the reversible step. A token is not money — it can be taken and the
    // checkout abandoned and nobody is out anything — and it was taken before this request began.
    // So the orders are written first and every charge happens at step 3, which satisfies both
    // halves of the owner's rule more directly than a hold does. `lib/payment-split.ts`'s header
    // carries the argument.
    //
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
    //
    // On the split path this is a no-op result rather than a call: nothing is held, so there is
    // nothing to authorize and — importantly — nothing for the catch below to have to release.
    //
    // On the split path this IS a real hold — one authorization for the whole cart, which the
    // per-store captures below draw slices out of. It is the reversible half the ordering rule
    // needs: measured, `refund-sale` against an uncaptured authorization answers `voided`, so a
    // failure between here and the captures costs the buyer nothing.
    const payment = splitPlan && splitInput && paymeCreds
      ? await (async () => {
          const res = await authorizeCart(splitInput!, splitPlan!, paymeCreds);
          return res.ok
            ? { ok: true as const, paymentRef: res.authorizationId, error: undefined }
            : { ok: false as const, paymentRef: undefined, error: res.detail };
        })()
      : await paymentProvider.authorize({ amount: fromAgorot(grandTotalAgorot), checkoutRef, buyerEmail: buyerData.buyerEmail, idempotencyKey });
    // Journalled whether it succeeded or failed — a decline is exactly the kind of
    // event that is invisible afterwards (no order row is left behind to show it
    // happened) and exactly what someone asks about later.
    //
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
    const storeSlices = Object.entries(storeSubtotals);
    for (const [sliceIndex, [storeSlug, sub]] of storeSlices.entries()) {
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
        // The slice is NAMED when there is more than one, and it is the row's own answer to the
        // question the journal's shape provokes (owner, סשן ב׳: "why is one purchase several
        // rows here?"). One cart across three stores is one charge and three orders, so the
        // journal shows three of these — and a reader scrolled away from the panel's explanation
        // has nothing on the row itself saying they are the same purchase. Omitted at one store,
        // where "חנות 1 מתוך 1" would be noise on the overwhelmingly common case.
        detail: `${storeSlices.length > 1 ? `חנות ${sliceIndex + 1} מתוך ${storeSlices.length} בקנייה זו · ` : ''}${heCount(storeItems.length, 'פריט', 'פריטים')} · אסמכתת סליקה ${payment.paymentRef ?? '—'}`,
      });
    }

    // ── Step 3 of 3: CAPTURE. The irreversible step, and the orders provably exist. ──
    // A failure here is the one remaining bad window, and it is now a HARMLESS one: the hold is
    // released, the orders that were written are marked failed and cancelled, and their stock goes
    // back. The rows survive rather than being deleted — a money record is evidence, and "an
    // attempted purchase that could not be paid for" is exactly the thing someone asks about — but
    // nothing is shippable, nothing counts as revenue (order-status-rules.ts), and no seller is
    // told about it, because the seller notifications are below this point and not above it.
    //
    // **On the split path this one call becomes N+1 charges** — one per store into that seller's
    // own merchant account with our commission taken inside the transaction, plus the delivery fee
    // on ours. `chargeSplit` runs them in order and, if any of them refuses, refunds every one that
    // already went through. Its failure shape is richer than a boolean for one reason: a refund can
    // itself fail, and that is money a real person is owed with nothing else pointing at it.
    const capture: { ok: boolean; error?: string; refsByStore?: Map<string, string> } = splitPlan && splitInput && paymeCreds
      ? await chargeSplitAsCapture(payment.paymentRef ?? '', splitInput, splitPlan, paymeCreds, checkoutRef)
      : await paymentProvider.capture({
          paymentRef: payment.paymentRef ?? '',
          idempotencyKey,
          amount: fromAgorot(grandTotalAgorot),
        });
    if (!capture.ok) {
      await failCapture(orderIds, checkoutRef, grandTotalAgorot, capture.error);
      // `held` is cleared only after the void so the catch below cannot double-release it. Always
      // null on the split path — nothing was held there — so this is the mock path's compensation.
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
    // Each store's order gets ITS OWN sale reference, not one shared ref: under the split there are
    // N+1 transactions at PayMe and a refund names exactly one of them. A shared reference here
    // would leave a cancelled single-store order with nothing to refund against.
    await markOrdersPaid(createdOrders, checkoutRef, payment.paymentRef, capture.refsByStore);
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

      // The buyer's tax invoice for this slice, owed by the SELLER — under the agent model they are
      // the one selling, and `terms.astro` promises the buyer that we produce it for them.
      //
      // Planned here rather than issued: no document is created yet, because issuing in another
      // business's name binds a מספר הקצאה to THEIR tax file and whether we may is a רו״ח question
      // that is open (`lib/invoicing/index.ts`). The row makes the obligation real and countable
      // from the moment the money is taken, which is the only moment at which it is certainly owed.
      //
      // After the capture and after the notification, deliberately: nothing in this block may
      // affect whether the purchase stands, and the seller finding out about the order matters more
      // than a document nothing issues yet. Not logged as an error — a failure to plan leaves the
      // same state as never having planned, and `countPendingDocuments()` reports the backlog
      // rather than each miss.
      //
      // **try/catch, NOT `.catch()`, and that distinction cost a real bug.** This was written as
      // `getSellerById(...).catch(() => null)`, which handles a REJECTED promise and does nothing
      // at all about a synchronous throw — and a synchronous throw here escaped the loop entirely
      // and skipped the low-stock and out-of-stock alerts below it, on a purchase that had already
      // been charged. `tests/checkout.test.ts` caught it. Anything running after `committed` on a
      // money path gets a statement-level guard, because the failure mode is never "this bit did
      // not happen" — it is "everything after this bit did not happen".
      try {
        const invoiceSeller = await getSellerById(store.sellerId);
        if (invoiceSeller) await planBuyerInvoice(storeOrder, store.slug, invoiceSeller);
      } catch { /* the obligation stays unplanned; the backlog count is the record */ }
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
        // Deliberately the RAW selection, not the one `resolveSelection` canonicalised above: this
        // key has to match a row the CLIENT wrote into the cart, so re-spelling it in the
        // product's vocabulary would leave the purchased line sitting in the buyer's cart. The
        // loop above has already refused anything that does not name a real combo, so the two
        // differ only in whitespace, and only the cart's own spelling can delete the cart's row.
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

    // `conversion` rides on the 201s only, never on the `replayed: true` response above: the same
    // purchase arriving twice is one sale, and the browser fires the conversion event off the
    // presence of this field precisely so a replay cannot double-count it.
    return json({ orderIds, checkoutRef, ...conversion }, 201);
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
    if (committed) return json({ orderIds, checkoutRef, ...conversion }, 201);
    return json({ error: 'Checkout failed, please try again' }, 500);
  }
}
