import { updateOrder, type Order } from './orders.js';
import { canTransition, orderHoldsStock, type ShippingStatus } from './order-status-rules.js';
import { recordMoneyEvent } from './money-events.js';
import { recordRefundOwed } from './refund-owed.js';
import { restockProduct } from './store-products.js';
import { notifyOrderStatusChanged } from './order-notify.js';
import { settleStoreClosure } from './store-lifecycle.js';
import { sendStoreLifecycleEmail } from './email/store-lifecycle-email.js';
import { getSellerById } from './seller-auth.js';
import { orderNetForStore } from './admin-stats.js';
import { logError } from './error-log.js';

/**
 * **Everything that must happen when an order's shipping status moves — in ONE place.**
 *
 * ── Why this was extracted (2026-08-10) ──
 * All of it lived inside `PATCH /api/seller/orders`, which was fine while a seller clicking a
 * dropdown was the only way a status could ever change. It stopped being fine the moment a second
 * caller appeared: the SLA job that cancels an order the seller never shipped and gives the buyer
 * their money back (`order-sla-run.ts`, GO_LIVE §5.0-ב). A second copy of this sequence would have
 * been a second definition of what a cancellation DOES — and the two halves that must not drift are
 * exactly the expensive ones: **stock going back on the shelf** and **the buyer's refund obligation
 * being recorded**. An automatic cancel that restocked but wrote no `refund_due` would take a
 * product back and keep the money, with nothing on any screen saying so.
 *
 * A third caller is already named and coming: the courier webhook (GO_LIVE §5.0-0) will move orders
 * to `shipped`/`delivered` from outside the dashboard entirely. It calls this.
 *
 * ── Why the effects are a separate function from the cancel ──
 * The API route updates the order ONCE, with the status change and the seller's other edits (items,
 * shipping override, discount) in the same write — so it cannot hand the write itself to a library
 * without either doing two writes or passing its whole payload through. `settleStatusChange` takes
 * the before/after pair and owns only the consequences; `cancelOrderForStore` is the whole path for
 * a caller that has no route around it. Both go through the same consequences, which is the point.
 *
 * ── The order of the five consequences is deliberate ──
 * Journal first (a record of what was decided, before anything acts on it), then the refund
 * obligation, then stock, then the buyer, then the store's pending closure. Everything after the
 * journal is caught or internally resilient: the status is already persisted by the time this runs,
 * so nothing here may turn a completed status change into an error for the caller.
 */

/** What this module needs to know about the store the slice belongs to. A projection, so a caller
 *  holding a full `Store` and one holding three columns from a job's query both fit. */
export interface StatusChangeStore {
  slug: string;
  name: string;
  sellerId: string;
}

export interface StatusChangeOutcome {
  /** Items whose units really went back on the shelf. 0 when the move did not release stock. */
  restocked: number;
  /** What the buyer is now owed, as `refund-owed.ts` recorded it. 0 when nothing was captured. */
  refundOwedAgorot: number;
  /** The store this move finished closing, if it was the last open order. Null otherwise. */
  closedStoreSlug: string | null;
}

/**
 * Apply the consequences of a status move that has ALREADY been persisted.
 *
 * `before` is the order as it was read before `updateOrder`; `after` is what came back. Callers
 * that did not change the status must not call this — the whole body is guarded on the move being
 * real, but a caller asking for consequences of a non-event is a caller with a bug.
 *
 * Never throws. See the header: the write it reports on is already done.
 */
export async function settleStatusChange(input: {
  before: Order;
  after: Order;
  store: StatusChangeStore;
  /** Who moved it — a seller id, or `'system'` for a scheduled job. Journal only. */
  actor: string;
  /** Extra context for the journal row, appended to whatever this module says itself. */
  detail?: string;
}): Promise<StatusChangeOutcome> {
  const { before, after, store, actor } = input;
  const outcome: StatusChangeOutcome = { restocked: 0, refundOwedAgorot: 0, closedStoreSlug: null };
  if (after.shippingStatus === before.shippingStatus) return outcome;

  // Journal every money-relevant mutation before acting on it (lib/money-events.ts). A status move
  // is a money event even though no amount changes hands: 'cancelled' is what takes an order OUT of
  // every revenue sum while leaving paymentStatus at 'paid', so without this entry there is no
  // record of why a seller's reported revenue dropped between two views of the same period.
  const restocking = !orderHoldsStock(after);
  const said = [
    restocking ? 'cancelled — items restocked, order leaves every revenue sum (countsAsRevenue)' : '',
    input.detail ?? '',
  ].filter(Boolean).join('; ');
  await recordMoneyEvent({
    type: 'shipping_status_changed',
    orderId: after.id,
    checkoutRef: after.checkoutRef,
    storeSlug: store.slug,
    amountAgorot: orderNetForStore(after, store.slug),
    from: before.shippingStatus,
    to: after.shippingStatus,
    actor,
    ...(said ? { detail: said } : {}),
  });

  // …and, separately, whether that move left the BUYER owed money. The row above is a fulfilment
  // fact: the order stopped counting and the seller stopped owing a parcel. It says nothing about
  // the money, which was really captured off a real card and is still ours until someone gives it
  // back. `refund-owed.ts` owns the rule and writes the obligation.
  //
  // The two ids are two different things and only coincide on the seller's own path: `actor` is who
  // performed the move (for the journal), `store.sellerId` is whose BALANCE the clawback comes out
  // of. On the SLA job the actor is 'system' and the balance is still the seller's — which is
  // precisely the case the old inline version could not express.
  outcome.refundOwedAgorot = await recordRefundOwed(before, after, store.slug, actor, store.sellerId);

  // Stock goes back when the order stops holding it — asked of the status table (holdsStock) rather
  // than tested against 'cancelled', so a future "returned" or "refunded" status restocks by filling
  // in a row instead of by someone remembering this line exists. Each order is single-store
  // (checkout creates one per store), so all items belong to this seller — safe to restock the lot.
  // Guarded by the before!==after check above, so a repeat request cannot double-restock.
  if (orderHoldsStock(before) && restocking) {
    for (const item of after.items) {
      await restockProduct(item.productId, item.qty, item.selectedVariants);
      outcome.restocked++;
    }
  }

  // Source-agnostic status pipeline: whoever moved the status (seller, scheduled job, carrier
  // webhook later), the buyer gets told. No-op if there is nothing to say — see order-notify.ts.
  //
  // **Caught, because of what sits AFTER it.** The status is already persisted and the stock is
  // already back by this line, so telling the buyer is the least load-bearing thing in the block —
  // but it is in the middle of it. A throw here would fail a status change that had in fact
  // succeeded, and, worse, would skip `settleStoreClosure` below: a seller who asked to close their
  // store and was waiting on this last open order would have the closure silently not happen, with
  // nothing to retry because the status change will never fire again. Both halves inside
  // `notifyOrderStatusChanged` already swallow their own failures, so this is the outer net for the
  // parts that are not I/O — and the ordering, not the odds, is the reason it is here.
  //
  // `try`/`catch` and not `.catch()`: this covers a SYNCHRONOUS throw as well as a rejection, and
  // the two are different paths — the first version chained `.catch` and blew up on a stub that
  // returns nothing, which is a fair warning about assuming the shape of what comes back.
  try {
    await notifyOrderStatusChanged(after, before.shippingStatus, { storeName: store.name, storeSlug: store.slug });
  } catch { /* the status change and the restock both stand */ }

  // A seller who asked to close the store while orders were still open gets that closure completed
  // HERE, the moment the last one stops being an open obligation — rather than having to come back
  // and press the button a second time (store-lifecycle.ts). No-op unless a closure is actually
  // pending and actually unblocked, so it costs one status read on a status change and nothing
  // otherwise.
  //
  // Caught rather than allowed to throw, which it was NOT before this module existed — inside the
  // route a failure here 500'd a status change that had already been persisted, restocked and
  // announced to the buyer. It is logged instead of swallowed, under its own route name so its
  // severity is judged as "a closure did not settle" and not as "the orders API is broken"
  // (`error-severity.ts`); the seller can still press the button again, which is exactly what makes
  // it recoverable and not worth failing a completed status move over.
  const justClosed = await settleStoreClosure(store.slug).catch((err: unknown) => {
    void logError({
      source: 'server',
      route: 'order-status:closure',
      message: `settleStoreClosure failed after ${after.id} moved to ${after.shippingStatus}: ${err instanceof Error ? err.message : String(err)}`,
      storeSlug: store.slug,
      storeName: store.name,
      actorRole: 'seller',
      actorId: store.sellerId,
      resolutionHint: 'שינוי הסטטוס נשמר והמלאי חזר — רק סגירת החנות הממתינה לא הושלמה. המוכר יכול ללחוץ "סגור חנות" שוב.',
    });
    return null;
  });
  if (justClosed) {
    outcome.closedStoreSlug = justClosed.slug;
    // The one state change in this whole feature the seller did NOT just click a button for — it
    // happened because they finished an order. Without this mail the store would close silently and
    // they would find out by visiting it. Not awaited; it never throws.
    const seller = await getSellerById(store.sellerId).catch(() => null);
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

  return outcome;
}

export type StatusChangeFailure = { ok: false; error: string; status: number };
export type StatusChangeSuccess = { ok: true; order: Order; outcome: StatusChangeOutcome };

/**
 * Move one order to a new shipping status and settle every consequence — the whole path, for a
 * caller with no HTTP route around it (the SLA job today, a courier webhook next).
 *
 * The transition rules are `canTransition`'s, not a second copy: a job cancelling an order that a
 * seller cancelled thirty seconds earlier is refused for exactly the reason a second dashboard
 * click is, and once refunds are real, "a 200 on a repeat cancel" is a second refund.
 *
 * `status` on the failure is the HTTP code a route would return, so the one caller that IS a route
 * does not have to map reasons back to numbers.
 */
export async function moveOrderStatus(input: {
  order: Order;
  to: ShippingStatus;
  store: StatusChangeStore;
  actor: string;
  detail?: string;
}): Promise<StatusChangeSuccess | StatusChangeFailure> {
  const { order, to, store, actor } = input;

  const verdict = canTransition(order.shippingStatus, to);
  if (!verdict.ok) return { ok: false, error: verdict.reason, status: 409 };

  const after = await updateOrder(order.id, { shippingStatus: to });
  if (!after) return { ok: false, error: 'Order not found', status: 404 };

  const outcome = await settleStatusChange({
    before: order,
    after,
    store,
    actor,
    ...(input.detail ? { detail: input.detail } : {}),
  });
  return { ok: true, order: after, outcome };
}
