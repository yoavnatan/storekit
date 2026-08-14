// Order-status emails — the buyer-facing half of the fulfilment automation that
// reaches EVERY buyer, guests included (the in-app notification only reaches
// registered buyers). Fired from the source-agnostic pipeline
// (order-notify.ts → notifyOrderStatusChanged) on ready / shipped / cancelled,
// so the same email goes out whether the seller moved the status today or a
// carrier webhook does tomorrow. Copy comes from order-status-copy.ts (shared
// with the in-app channel so wording can't drift).
//
// buildOrderStatusEmail is PURE (unit-testable); sendOrderStatusEmail is the thin
// resilient side-effecting wrapper.

import type { Order } from '../orders.js';
import { store } from '../../config/store.config.js';
import { STATUS_MESSAGES, isEmailedStatus, type NotifiableStatus } from '../order-status-copy.js';
import { logError } from '../error-log.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc } from './template.js';
import { storeMeta, storefrontUrl, storeHeader, itemsTable, refLine, ctaButton } from './parts.js';
import { sendEmail } from './index.js';

/**
 * Build the status-change email for a buyer, or null when the status doesn't earn one.
 *
 * Two gates, not one, and they are different questions. STATUS_MESSAGES answers "is there any
 * buyer-facing wording for this at all" (excludes 'processing' / 'delivered' / back to 'pending').
 * EMAILED_STATUSES answers "is it worth an inbox interruption" — 'ready' has copy, shows in-app,
 * and deliberately sends no mail. The reasoning lives at the constant, in order-status-copy.ts.
 * Pure — no I/O.
 */
export function buildOrderStatusEmail(order: Order, status: string): EmailMessage | null {
  if (!isEmailedStatus(status)) return null;
  const msg = STATUS_MESSAGES[status as NotifiableStatus];
  if (!msg) return null;

  const ref = order.checkoutRef ?? order.id;
  const { name: storeName, slug } = storeMeta(order);
  const cancelled = status === 'cancelled';

  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(order.buyerName)},</p>
<p style="margin:0 0 12px;">${esc(msg.body(order))}</p>
${refLine(ref)}
${storeHeader(order)}
${itemsTable(order.items)}
${cancelled ? '' : ctaButton(storefrontUrl(slug), 'לצפייה בחנות')}`;

  return {
    to: order.buyerEmail,
    subject: `${msg.title} · ${store.name} (${ref})`,
    html: renderEmailShell({ previewText: `${msg.title} — ${storeName}`, heading: msg.title, bodyHtml }),
    text: `שלום ${order.buyerName},\n${msg.body(order)}\nמספר אסמכתא: ${ref}\nחנות: ${storeName}\n\n${store.name}`,
  };
}

/**
 * Side-effecting entry point — call after a status change is persisted (from the
 * order-notify pipeline). No-op for non-notifiable statuses. Fully resilient:
 * never throws, logs its own failures, so a mail problem can't affect the status
 * update that triggered it.
 */
export async function sendOrderStatusEmail(order: Order, status: string): Promise<void> {
  try {
    const email = buildOrderStatusEmail(order, status);
    if (!email) return;
    const res = await sendEmail(email);
    if (!res.ok) {
      void logError({
        source: 'server',
        route: '/api/seller/orders',
        message: `Order-status email (${status}) failed: ${res.error ?? 'unknown'}`,
        statusCode: 502,
        actorRole: 'buyer',
        actorLabel: order.buyerEmail,
        resolutionHint: 'עדכון הסטטוס לקונה לא נשלח במייל. ההזמנה עודכנה תקין; לבדוק את מודול המייל.',
      });
    }
  } catch (err) {
    void logError({
      source: 'server',
      route: '/api/seller/orders',
      message: `Order-status email pipeline (${status}) failed: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      actorRole: 'buyer',
      actorLabel: order.buyerEmail,
      resolutionHint: 'כשל בשליחת מייל עדכון סטטוס. ההזמנה עודכנה תקין.',
    });
  }
}
