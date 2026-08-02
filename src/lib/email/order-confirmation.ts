// Side-effecting entry point for the order-confirmation automation.
//
// Mirrors order-notify.ts: the pure builders (order-emails.ts) decide WHAT to
// send; this thin wrapper resolves recipients and does the actual sending.
// Called once right after checkout commits its orders. Fire-and-forget from the
// caller's perspective — it awaits internally but every send is resilient, so a
// mail failure is logged, never thrown back into checkout.

import type { Order } from '../orders.js';
import { getStoreBySlugOrPrevious } from '../stores.js';
import { getSellerById } from '../seller-auth.js';
import { logError } from '../error-log.js';
import { sendEmail } from './index.js';
import { buildBuyerOrderConfirmation, buildSellerOrderNotification } from './order-emails.js';

/**
 * Send the buyer one confirmation for the whole checkout, and each seller a
 * notification for their own order. `orders` are all the per-store orders that
 * a single checkout produced (same checkoutRef).
 */
export async function sendOrderConfirmationEmails(orders: Order[]): Promise<void> {
  if (!orders.length) return;
  try {
    await deliver(orders);
  } catch (err) {
    // Belt-and-suspenders: sendEmail never throws, but recipient resolution
    // (store/seller lookup, template build) still touches I/O — a failure here
    // must not become an unhandled rejection off the fire-and-forget call.
    logError({
      source: 'server',
      route: '/api/checkout',
      message: `Order-confirmation email pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      actorRole: 'buyer',
      actorLabel: orders[0]?.buyerEmail,
      resolutionHint: 'מיילי אישור ההזמנה לא נשלחו. ההזמנה נקלטה תקין; לבדוק את מודול המייל.',
    });
  }
}

async function deliver(orders: Order[]): Promise<void> {
  // Buyer — one email covering every store in the checkout.
  const buyerMsg = buildBuyerOrderConfirmation(orders);
  const buyerResult = await sendEmail(buyerMsg);
  if (!buyerResult.ok) {
    logError({
      source: 'server',
      route: '/api/checkout',
      message: `Buyer order-confirmation email failed: ${buyerResult.error ?? 'unknown'}`,
      statusCode: 502,
      actorRole: 'buyer',
      actorLabel: orders[0]!.buyerEmail,
      resolutionHint: 'אישור ההזמנה לקונה לא נשלח במייל. ההזמנה עצמה נקלטה תקין; אפשר לשלוח אישור ידנית או לבדוק את חיבור ספק המייל.',
    });
  }

  // Sellers — one email each, to the account email behind the order's store.
  for (const order of orders) {
    const storeSlug = order.items[0]?.storeSlug;
    const store = storeSlug ? getStoreBySlugOrPrevious(storeSlug) : null;
    const seller = store ? await getSellerById(store.sellerId) : null;
    if (!seller?.email) continue;
    const result = await sendEmail(buildSellerOrderNotification(order, seller.email));
    if (!result.ok) {
      logError({
        source: 'server',
        route: '/api/checkout',
        message: `Seller order-notification email failed: ${result.error ?? 'unknown'}`,
        statusCode: 502,
        actorRole: 'seller',
        actorId: store?.sellerId,
        actorLabel: seller.email,
        storeSlug: store?.slug,
        storeName: store?.name,
        resolutionHint: 'הודעת ההזמנה למוכר לא נשלחה במייל. ההזמנה מופיעה בדשבורד המוכר כרגיל; לבדוק את חיבור ספק המייל.',
      });
    }
  }
}
