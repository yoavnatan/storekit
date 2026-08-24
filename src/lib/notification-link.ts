/**
 * Where a notification takes the person who clicks it.
 *
 * **The destination depends on `role` first, `type` second — and that is the whole reason this
 * file exists.** Both renderers used to branch on `type` alone, and `order_update` is written for
 * BOTH sides: `order-notify.ts` writes it to the BUYER ("ההזמנה שלך נשלחה") and `order-sla-run.ts`
 * writes it to the SELLER. A type-only table sent every buyer who clicked their own shipping
 * notification into `/seller/dashboard`, and everything it did not recognise (`feed_status`,
 * `low_stock` from the toast path) into the buyer dashboard. A notification row carries the role it
 * was written for; asking it is exact, and no other signal is.
 *
 * **One table, two renderers.** The dropdown (`Header.astro`, a bundled module script) and the
 * toast poller (`BaseLayout.astro`, an `is:inline` plain-JS block that cannot import anything) both
 * need this answer, so `/api/notifications` computes it once per row and ships it as `href`. That
 * is why the rule lives server-side rather than in a client helper: it is the only place both
 * consumers can reach. `tests/notification-link.test.ts` pins the table and fails if either
 * renderer grows a second copy of it.
 *
 * An unknown `type` is not an error — the column has no CHECK precisely so a row from another
 * deploy still renders (see `notifications.ts`). It lands on that role's dashboard root, which is
 * always somewhere the reader is allowed to be.
 */

import type { NotificationRole, NotificationType } from './notifications.js';

interface Linkable {
  role: NotificationRole;
  type: NotificationType | string;
  relatedId?: string;
}

export function notificationHref(n: Linkable): string {
  if (n.role === 'buyer') {
    switch (n.type) {
      case 'seller_reply':
      case 'new_message':
        return '/buyer/dashboard?tab=messages';
      case 'order_update':
        return '/buyer/dashboard?tab=orders';
      default:
        return '/buyer/dashboard';
    }
  }

  switch (n.type) {
    case 'new_message':
      return '/seller/dashboard?panel=messages';
    // A system message's relatedId is its THREAD id (admin/messages.ts) — the same value the
    // dashboard row carries as data-msg-id, so the deep-link opens that exact conversation.
    case 'admin_message':
      return `/seller/dashboard?panel=messages${n.relatedId ? `&msg=${encodeURIComponent(n.relatedId)}` : ''}`;
    case 'new_order':
    case 'order_update':
      return '/seller/dashboard?panel=orders';
    // A return is NOT an order update, even though it carries an order's id (owner, 2026-08-23:
    // *"לחיצה עליו לא מביאה להחזרות אלא להזמנות"*). Every one of these was written as
    // `order_update` — the type it is closest to — and so every one of them landed on the orders
    // tab, including the one whose own body says *"תראה אותה בלשונית החזרות"*. `relatedId` stays
    // the order id, because that is what the returns panel and the order card both key off; what
    // changed is which tab owns the answer. The buyer keeps `order_update` for the same news: his
    // dashboard has no returns tab, and a return shows inside the order it came from.
    case 'return_update':
      return '/seller/dashboard?panel=returns';
    case 'payout_status':
      return '/seller/dashboard?panel=payouts';
    // Both stock alerts and a feed rejection are fixed on the product itself — the feed
    // notification's own body says "תקן את המוצר", so it must not land on the ads tab.
    case 'low_stock':
    case 'out_of_stock':
      return '/seller/dashboard?panel=products';
    // `feed_status` covers two different pieces of news, told apart by their key rather than by
    // their type: an ad network rejecting one PRODUCT (`feed:<network>:<id>:<reason>`, fixed on the
    // product) and the external inventory sync failing (`feed-sync:<storeId>:<problem>`, fixed in a
    // panel the seller then has to find). The second one opens that panel — the alert says "open
    // the sync panel", so landing on the tab and leaving them to hunt for it is half an answer.
    case 'feed_status':
      return n.relatedId?.startsWith('feed-sync:')
        ? '/seller/dashboard?panel=products&feed=1'
        : '/seller/dashboard?panel=products';
    case 'domain_status':
      return '/seller/dashboard?panel=settings';
    // The overview, because that is where the "not live yet" card was: the seller last saw a screen
    // telling him what was missing, and this is the same screen with nothing left on it.
    case 'store_live':
      return '/seller/dashboard';
    default:
      return '/seller/dashboard';
  }
}
