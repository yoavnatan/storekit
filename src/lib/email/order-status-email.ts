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
import { SITE, storeMeta, storefrontUrl, storeHeader, itemsTable, refLine, ctaButton } from './parts.js';
import { orderHelpUrl } from '../order-token.js';
import { sendEmail } from './index.js';
import { formatAgorot } from '../money.js';

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
${cancelled ? '' : ctaButton(storefrontUrl(slug), 'לצפייה בחנות')}
<p style="margin:16px 0 0;font-size:13px;"><a href="${orderHelpUrl(SITE, order.id)}" style="color:#5a6478;">פנייה בנוגע להזמנה</a></p>`;

  return {
    to: order.buyerEmail,
    subject: `${msg.title} · ${store.name} (${ref})`,
    html: renderEmailShell({ previewText: `${msg.title} — ${storeName}`, heading: msg.title, bodyHtml }),
    text: `שלום ${order.buyerName},\n${msg.body(order)}\nמספר אסמכתא: ${ref}\nחנות: ${storeName}\n\n${store.name}`,
  };
}

/**
 * **The order got cheaper after the buyer had already paid for it.**
 *
 * A seller can delete a line they cannot fulfil, change the shipping, or hand back part of the
 * price as goodwill. Every one of those leaves a buyer who paid one number looking at an order that
 * shows a smaller one — and until 2026-08-18 nothing told them, because the whole notification
 * pipeline hangs off a SHIPPING STATUS change and an edit is not one.
 *
 * ⚠️ **This mail promises money back, so it is one of the things to verify hardest when a real
 * gateway is wired** (owner asked for the warning to live here rather than in a checklist). Today
 * `refund_due` is recorded and nothing settles it — by design; `refund-owed.ts` explains why — so
 * the sentence below is a promise the system cannot yet keep on its own. The day a provider can
 * refund, three things have to become true TOGETHER, and they are easy to get separately: the money
 * actually leaves, `refund_settled` is written, and this mail names the same amount that moved. A
 * buyer told 40 who receives 35 is a complaint; one told and sent nothing is a chargeback.
 *
 * The amount is stated rather than "your order was updated", on purpose: a card statement does not
 * change retroactively, so a message that does not name the difference leaves the buyer to work it
 * out against a charge that no longer matches anything on screen.
 */
export function buildOrderCheapenedEmail(order: Order, owedAgorot: number): EmailMessage | null {
  if (owedAgorot <= 0) return null;
  const ref = order.checkoutRef ?? order.id;
  const { name: storeName, slug } = storeMeta(order);
  const amount = formatAgorot(owedAgorot);
  const title = 'ההזמנה שלך עודכנה — מגיע לך החזר';
  const line = `החנות ${storeName} עדכנה את ההזמנה שלך והסכום ירד. ההפרש — ${amount} — יוחזר לאמצעי התשלום שבו שילמת.`;

  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(order.buyerName)},</p>
<p style="margin:0 0 12px;">${esc(line)}</p>
${refLine(ref)}
${storeHeader(order)}
${itemsTable(order.items)}
${ctaButton(storefrontUrl(slug), 'לצפייה בחנות')}
<p style="margin:16px 0 0;font-size:13px;"><a href="${orderHelpUrl(SITE, order.id)}" style="color:#5a6478;">פנייה בנוגע להזמנה</a></p>`;

  return {
    to: order.buyerEmail,
    subject: `${title} · ${store.name} (${ref})`,
    html: renderEmailShell({ previewText: `${amount} יוחזרו לך — ${storeName}`, heading: title, bodyHtml }),
    text: `שלום ${order.buyerName},\n${line}\nמספר אסמכתא: ${ref}\nחנות: ${storeName}\n\n${store.name}`,
  };
}

/** Side-effecting twin of the above. Never throws, for the reason `sendOrderStatusEmail` does not. */
export async function sendOrderCheapenedEmail(order: Order, owedAgorot: number): Promise<void> {
  try {
    const email = buildOrderCheapenedEmail(order, owedAgorot);
    if (!email) return;
    const res = await sendEmail(email);
    if (!res.ok) {
      void logError({
        source: 'server',
        route: '/api/seller/orders',
        message: `order-cheapened email failed for ${order.id}`,
        statusCode: 0,
      });
    }
  } catch { /* a mail problem must never affect the edit that triggered it */ }
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
