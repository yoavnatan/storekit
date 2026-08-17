// "How was it?" — the mail that makes reviews reachable at all.
//
// Every other entry point into the review form needs an ACCOUNT: the product page offers it to a
// signed-in buyer, the orders list links to it. Guest checkout is the default on this platform
// (AI_INSTRUCTIONS → Checkout), so without this mail the majority of buyers would never be asked,
// and a purchase-verified review system that nobody is invited to is an empty one.
//
// The link carries the proof (`review-token.ts`): no password, no account, one tap. What it
// authorises is bounded by the order — see that file for why a leaked link is no worse than a
// forwarded order confirmation.
//
// `buildReviewInviteEmail` is PURE and unit-tested; `sendReviewInviteEmail` is the thin
// side-effecting wrapper, same split as `order-status-email.ts` beside it.

import type { Order } from '../orders.js';
import { store } from '../../config/store.config.js';
import { logError } from '../error-log.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc } from './template.js';
import { storeMeta, refLine, ctaButton } from './parts.js';
import { sendEmail } from './index.js';
import { reviewInviteUrl } from '../review-token.js';
import { orderIsReviewable } from '../review-eligibility.js';

/**
 * The invitation, or null when this order has no business receiving one.
 *
 * The gate is the same `orderIsReviewable` the API and both screens use — never a status
 * comparison written here. An order that was cancelled, or has not shipped, or was never paid for,
 * gets nothing: an invitation to review a parcel that did not arrive is the worst mail this
 * platform could send.
 */
export function buildReviewInviteEmail(order: Order): EmailMessage | null {
  if (!orderIsReviewable(order)) return null;
  if (!order.buyerEmail) return null;

  const ref = order.checkoutRef ?? order.id;
  const { name: storeName } = storeMeta(order);
  const heading = 'איך היה?';
  // The product names, so the mail is about a thing the buyer remembers and not about an order
  // number. Capped — a twenty-line basket does not need to be re-listed to ask one question.
  const names = order.items.slice(0, 4).map((i) => i.productName);
  const more = order.items.length > names.length;

  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(order.buyerName)},</p>
<p style="margin:0 0 12px;">קניתם ב${esc(storeName)}${names.length ? `: ${esc(names.join(', '))}${more ? '…' : ''}` : ''}.</p>
<p style="margin:0 0 12px;">דירוג אחד, כמה שניות — והוא עוזר לקונים הבאים ולחנות עצמה.</p>
${refLine(ref)}
${ctaButton(reviewInviteUrl(store.url, order.id), 'לדירוג הרכישה')}
<!-- The same door the page carries, said here because this is where the wrong reflex starts: a
     buyer whose parcel never came opens the mail already annoyed and the only button in it says
     "rate your purchase". Four words, no explanation — see review/[orderId].astro. -->
<p style="margin:16px 0 0;font-size:13px;"><a href="${reviewInviteUrl(store.url, order.id)}" style="color:#5a6478;">לא קיבלתי את ההזמנה</a></p>`;

  return {
    to: order.buyerEmail,
    subject: `${heading} · ${storeName} (${ref})`,
    html: renderEmailShell({ previewText: `דירוג הרכישה מ${storeName}`, heading, bodyHtml }),
    text: `שלום ${order.buyerName}, איך הייתה הרכישה מ${storeName}? ${reviewInviteUrl(store.url, order.id)}`,
  };
}

/** Never throws: a mail that fails to send must not fail the job that sends a hundred of them. */
export async function sendReviewInviteEmail(order: Order): Promise<boolean> {
  const message = buildReviewInviteEmail(order);
  if (!message) return false;
  try {
    const result = await sendEmail(message);
    return result.ok;
  } catch (err) {
    void logError({
      source: 'server',
      route: '/jobs/review-invites',
      message: `Review-invite email failed: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      actorRole: 'buyer',
      actorLabel: order.buyerEmail,
      resolutionHint: 'ההזמנה תקינה; רק ההזמנה לדרג לא נשלחה. לבדוק את מודול המייל.',
    });
    return false;
  }
}
