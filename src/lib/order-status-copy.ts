// Single source of truth for the buyer-facing copy of an order-status change.
//
// Shared by BOTH downstream channels so their wording never drifts apart:
//   • in-app notification (order-notify.ts) — registered buyers
//   • email (email/order-status-email.ts) — every buyer, incl. guests
//
// Deliberately EXCLUDES 'processing' (בטיפול) and 'delivered' (נמסר): the first
// is the seller's internal work state (pinging the buyer adds no value and can
// backfire when marked late); the second is redundant — the buyer has the parcel
// and the carrier sends its own delivery confirmation once shipping is wired.
// The buyer only hears about real, actionable milestones.

import type { Order } from './orders.js';

export type NotifiableStatus = 'ready' | 'shipped' | 'cancelled';

/**
 * The subset that also earns an EMAIL. The two channels are not the same channel: an in-app
 * notification waits on a screen the buyer chose to open, while a mail interrupts an inbox, and a
 * milestone can be worth the first without being worth the second.
 *
 * `ready` is exactly that case (owner, 2026-08-14). "ההזמנה נארזה ומוכנה לשליחה" is the seller's
 * packing milestone — nothing is asked of the buyer, nothing has moved yet, and the parcel-is-on-
 * its-way mail follows it within hours. Two mails for one departure is the shape a buyer starts
 * filtering the sender out over, and the cost of that lands on `shipped` and `cancelled`, which
 * genuinely have to arrive.
 *
 * So `ready` keeps its in-app notification and loses its mail. Anything added here later should be
 * read the same way: does the buyer have to DO something, or has something real changed for them?
 */
export const EMAILED_STATUSES: readonly NotifiableStatus[] = ['shipped', 'cancelled'];

export function isEmailedStatus(status: string): status is NotifiableStatus {
  return (EMAILED_STATUSES as readonly string[]).includes(status);
}

export const STATUS_MESSAGES: Record<NotifiableStatus, { title: string; body: (o: Order) => string }> = {
  ready: {
    title: 'ההזמנה שלך מוכנה',
    body: () => 'ההזמנה נארזה ומוכנה לשליחה.',
  },
  shipped: {
    title: 'ההזמנה שלך נשלחה',
    // "אליך" was dropped on 2026-08-11 (user): the buyer is reading their own order page, so the
    // recipient is never in question, and the shorter sentence is the one that reads as a fact.
    body: (o) => o.trackingNumber
      ? `ההזמנה יצאה לדרך. מספר מעקב: ${o.trackingNumber}`
      : 'ההזמנה יצאה לדרך.',
  },
  cancelled: {
    title: 'ההזמנה שלך בוטלה',
    body: () => 'ההזמנה בוטלה. אם בוצע חיוב, יינתן החזר כספי.',
  },
};
