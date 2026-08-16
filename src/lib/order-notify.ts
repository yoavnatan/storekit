// Source-agnostic order-status notification pipeline.
//
// Whenever an order's shippingStatus changes — no matter WHO triggered it (the
// seller clicking a status in the dashboard today, or the shipping carrier's
// webhook once the carrier is wired, see GO_LIVE_CHECKLIST §5) — the SAME function
// runs and tells the buyer what happened. The trigger is manual/external; the
// downstream communication is what's automated. Wiring a carrier later means
// its webhook calls notifyOrderStatusChanged() too — nothing here changes.
//
// Reach: in-app notification for REGISTERED buyers (order.buyerId set) AND an
// email to EVERY buyer, guests included (email/order-status-email.ts) — the two
// channels share one copy source (order-status-copy.ts) so their wording can't
// drift. Wiring a carrier later means its webhook calls notifyOrderStatusChanged()
// too — both channels fire, nothing here changes.
//
// buildOrderStatusNotification is PURE (no I/O) so it's unit-testable; the thin
// notifyOrderStatusChanged wrapper does the actual writes/sends.

import type { Order } from './orders.js';
import { createNotification, type Notification } from './notifications.js';
import { STATUS_MESSAGES, type NotifiableStatus } from './order-status-copy.js';
import { sendOrderStatusEmail } from './email/order-status-email.js';

type BuyerNotificationInput = Omit<Notification, 'id' | 'read' | 'createdAt'>;

/**
 * Decide the in-app notification (if any) a status change should produce.
 * Returns null when there's nothing to send: no real status change, a guest
 * buyer (no account to notify), or a status with no buyer-facing message.
 * Pure — no I/O — so it's directly unit-testable.
 */
export function buildOrderStatusNotification(
  order: Order,
  prevStatus: string,
  opts: { storeName?: string; storeSlug?: string } = {},
): BuyerNotificationInput | null {
  if (order.shippingStatus === prevStatus) return null;   // no real change
  if (!order.buyerId) return null;                         // guest → email only
  const msg = STATUS_MESSAGES[order.shippingStatus as NotifiableStatus];
  if (!msg) return null;                                   // e.g. back to 'pending'
  return {
    userId: order.buyerId,
    role: 'buyer',
    type: 'order_update',
    title: msg.title,
    body: msg.body(order),
    relatedId: order.id,
    ...(opts.storeSlug ? { storeSlug: opts.storeSlug } : {}),
    ...(opts.storeName ? { storeName: opts.storeName } : {}),
  };
}

/**
 * Tell the SELLER his order was cancelled by the buyer.
 *
 * **The order does not vanish, but it does leave his default view**, and that is the gap this
 * closes (owner, 2026-08-16: *"יכול להיות שהוא ראה הזמנה, ואז פתאום היא נעלמה לו והוא לא מבין
 * לאן"*). His Orders tab filters to live orders, so a cancelled one is still there under "בוטלה"
 * and nowhere else — which from his side is indistinguishable from a row that disappeared.
 *
 * **A notification and not a mail, deliberately.** A cancellation before dispatch costs him nothing:
 * he had not packed it, and the units are already back on the shelf by the time this runs. That is
 * information, not an alarm — and a mail per cancellation is how a person learns to filter the
 * sender, which would cost us the one message that has to arrive (the dispute alert, and the
 * reasoning is the same one `returns-run.ts` records).
 *
 * Never throws: it is the last thing in a cancellation that has already succeeded, and a failed
 * notification must not fail it (the rule `settleStatusChange` states for the same reason).
 */
export async function notifySellerOrderCancelled(
  sellerId: string,
  order: Order,
  storeSlug: string,
  storeName?: string,
): Promise<void> {
  try {
    await createNotification({
      userId: sellerId,
      role: 'seller',
      type: 'order_update',
      title: 'הזמנה בוטלה על ידי הקונה',
      // The number he knows the order by, and the fact that costs him nothing — said in the same
      // breath, because "cancelled" alone reads as a problem and this one is not.
      body: `הזמנה ${order.checkoutRef ?? order.id.slice(0, 8)} בוטלה לפני שיצאה למשלוח. המלאי חזר אליך.`,
      relatedId: order.id,
      storeSlug,
      ...(storeName ? { storeName } : {}),
    });
  } catch {
    // Swallowed on purpose — see the header. The cancellation itself is already done and journalled.
  }
}

/**
 * Side-effecting entry point — call after an order's status is persisted.
 * Same signature for every trigger source (seller dashboard, future carrier
 * webhook). No-op when buildOrderStatusNotification decides there's nothing to
 * send, so callers can invoke it unconditionally.
 */
export async function notifyOrderStatusChanged(
  order: Order,
  prevStatus: string,
  opts: { storeName?: string; storeSlug?: string } = {},
): Promise<void> {
  // In-app notification — registered buyers only (guests have no account).
  // Swallowed on failure, and deliberately: the status this announces is already persisted, so a
  // database hiccup here must not turn a completed status update into a 500 for the seller who
  // made it. The buyer still gets the email below, which is the channel that reaches everyone.
  const input = buildOrderStatusNotification(order, prevStatus, opts);
  if (input) await createNotification(input).catch(() => { /* the status change itself stands */ });

  // Email — reaches EVERY buyer including guests (the majority, no account). Only
  // on a real status change; fire-and-forget + internally resilient so a mail
  // failure never affects the status update that triggered it.
  if (order.shippingStatus !== prevStatus) {
    void sendOrderStatusEmail(order, order.shippingStatus).catch(() => { /* handled inside */ });
  }
}
