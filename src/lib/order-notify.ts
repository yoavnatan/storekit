// Source-agnostic order-status notification pipeline.
//
// Whenever an order's shippingStatus changes — no matter WHO triggered it (the
// seller clicking a status in the dashboard today, or the shipping carrier's
// webhook once Sendit is wired, see GO_LIVE_CHECKLIST §5) — the SAME function
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
 * Side-effecting entry point — call after an order's status is persisted.
 * Same signature for every trigger source (seller dashboard, future carrier
 * webhook). No-op when buildOrderStatusNotification decides there's nothing to
 * send, so callers can invoke it unconditionally.
 */
export function notifyOrderStatusChanged(
  order: Order,
  prevStatus: string,
  opts: { storeName?: string; storeSlug?: string } = {},
): void {
  // In-app notification — registered buyers only (guests have no account).
  const input = buildOrderStatusNotification(order, prevStatus, opts);
  if (input) createNotification(input);

  // Email — reaches EVERY buyer including guests (the majority, no account). Only
  // on a real status change; fire-and-forget + internally resilient so a mail
  // failure never affects the status update that triggered it.
  if (order.shippingStatus !== prevStatus) {
    void sendOrderStatusEmail(order, order.shippingStatus).catch(() => { /* handled inside */ });
  }
}
