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

export const STATUS_MESSAGES: Record<NotifiableStatus, { title: string; body: (o: Order) => string }> = {
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
  cancelled: {
    title: 'ההזמנה שלך בוטלה',
    body: () => 'ההזמנה בוטלה. אם בוצע חיוב, יינתן החזר כספי.',
  },
};
