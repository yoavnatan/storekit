// Source-agnostic order-status notification pipeline.
//
// Whenever an order's shippingStatus changes — no matter WHO triggered it (the
// seller clicking a status in the dashboard today, or the shipping carrier's
// webhook once Sendit is wired, see GO_LIVE_CHECKLIST §5) — the SAME function
// runs and tells the buyer what happened. The trigger is manual/external; the
// downstream communication is what's automated. Wiring a carrier later means
// its webhook calls notifyOrderStatusChanged() too — nothing here changes.
//
// Reach today: in-app notification for REGISTERED buyers (order.buyerId set).
// Guest buyers have no account to notify — they'll be reached by email once the
// email channel lands (GO_LIVE_CHECKLIST §4). Copy is Hebrew-first literal,
// matching the rest of the notifications subsystem (checkout.ts / messages.ts).
//
// buildOrderStatusNotification is PURE (no I/O) so it's unit-testable; the thin
// notifyOrderStatusChanged wrapper does the actual write.

import type { Order } from './orders.js';
import { createNotification, type Notification } from './notifications.js';

export type NotifiableStatus = 'processing' | 'ready' | 'shipped' | 'delivered' | 'cancelled';

// Only these transitions carry a buyer-facing message. 'pending' is the initial
// state (no transition into it worth announcing).
const BUYER_MESSAGES: Record<NotifiableStatus, { title: string; body: (o: Order) => string }> = {
  processing: {
    title: 'ההזמנה שלך בטיפול',
    body: () => 'המוכר קיבל את הזמנתך ומתחיל להכין אותה.',
  },
  ready: {
    title: 'ההזמנה שלך מוכנה',
    body: () => 'ההזמנה נארזה ומוכנה לשליחה.',
  },
  shipped: {
    title: 'ההזמנה שלך נשלחה',
    body: (o) => o.trackingNumber
      ? `ההזמנה בדרך אליך. מספר מעקב: ${o.trackingNumber}`
      : 'ההזמנה יצאה לדרך אליך.',
  },
  delivered: {
    title: 'ההזמנה שלך נמסרה',
    body: () => 'ההזמנה הגיעה ליעדה. מקווים שתיהנה!',
  },
  cancelled: {
    title: 'ההזמנה שלך בוטלה',
    body: () => 'ההזמנה בוטלה. אם בוצע חיוב, יינתן החזר כספי.',
  },
};

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
  if (!order.buyerId) return null;                         // guest → email later
  const msg = BUYER_MESSAGES[order.shippingStatus as NotifiableStatus];
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
  const input = buildOrderStatusNotification(order, prevStatus, opts);
  if (input) createNotification(input);
}
