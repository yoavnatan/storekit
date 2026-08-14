// "The invoice for your order is ready" — the buyer's half of the invoicing feature.
//
// The platform does not issue the buyer's tax invoice; the seller does, from his own books, and
// uploads it against the order (`lib/invoicing/buyer-invoice.ts` carries that decision). The feature
// worked end to end except for one thing: nobody told the buyer. The document sat in his account
// area and he had to go and look for it, on a page he has no reason to reopen after a purchase.
//
// A LINK, never an attachment. The file already lives on Cloudinary, an attached PDF measurably
// costs deliverability, and the invoice is a document the buyer may want months later — a link into
// his account keeps working when the mail is long gone.
//
// `upload` only. `handover` (the seller put a printed invoice in the parcel) gets no mail: there is
// nothing to open, and "your invoice is ready" with no way to see it is a message that creates a
// question instead of answering one.
//
// buildInvoiceReadyEmail is PURE; sendInvoiceReadyEmail resolves the order itself and never throws.

import { store } from '../../config/store.config.js';
import { getOrderById } from '../orders.js';
import { logError } from '../error-log.js';
import type { Order } from '../orders.js';
import type { EmailMessage } from './adapter.js';
import { renderEmailShell, esc, emailColors as C } from './template.js';
import { SITE, storeMeta, refLine, ctaButton } from './parts.js';
import { sendEmail } from './index.js';

const ACCOUNT_URL = `${SITE}/buyer/dashboard`;

export interface InvoiceEmailInput {
  order: Order;
  /** Where the uploaded document lives. Already validated as one of ours by the route. */
  documentUrl: string;
}

export function buildInvoiceReadyEmail({ order, documentUrl }: InvoiceEmailInput): EmailMessage | null {
  // Both guards are "there is no mail to send", not "something went wrong": a guest checkout can
  // legitimately carry no address, and a document with no URL is the handover case reaching here by
  // mistake. Returning null keeps that judgement in one place instead of at every call site.
  if (!order.buyerEmail || !documentUrl) return null;

  const ref = order.checkoutRef ?? order.id;
  const { name: storeName } = storeMeta(order);

  const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(order.buyerName)},</p>
<p style="margin:0 0 12px;">החשבונית עבור ההזמנה שלך מחנות <strong>${esc(storeName)}</strong> מוכנה.</p>
${refLine(ref)}
${ctaButton(documentUrl, 'לצפייה בחשבונית')}
<p style="margin:20px 0 0;color:${C.muted};font-size:13px;line-height:1.6;">
החשבונית שמורה גם באזור האישי שלך, תחת ההזמנה הזאת — <a href="${esc(ACCOUNT_URL)}" style="color:${C.accent};text-decoration:none;">לאזור האישי</a>.
</p>
<p style="margin:8px 0 0;color:${C.muted};font-size:12px;line-height:1.6;">
החשבונית הופקה על ידי ${esc(storeName)}, ושאלות לגביה מופנות ישירות לחנות.
</p>`;

  return {
    to: order.buyerEmail,
    subject: `החשבונית שלך מוכנה · ${storeName} (${ref})`,
    html: renderEmailShell({
      previewText: `החשבונית להזמנה ${ref} מ-${storeName} מוכנה לצפייה`,
      heading: 'החשבונית שלך מוכנה',
      bodyHtml,
    }),
    text: [
      `שלום ${order.buyerName},`,
      `החשבונית עבור ההזמנה שלך מחנות ${storeName} מוכנה.`,
      `מספר אסמכתא: ${ref}`,
      '',
      `לצפייה בחשבונית: ${documentUrl}`,
      `לאזור האישי: ${ACCOUNT_URL}`,
      '',
      store.name,
    ].join('\n'),
  };
}

/**
 * Side-effecting entry point — call AFTER the upload is recorded, and `void` it.
 *
 * It loads the order itself rather than taking one, so the route hands over an id it has already
 * proved this seller owns and nothing else: the write that authorized this happened first, and the
 * mail is a consequence of it. Never throws — a mail failure must not turn a successful upload into
 * an error the seller sees, so it goes to the error log with a hint instead.
 */
export async function sendInvoiceReadyEmail(orderId: string, documentUrl: string | null): Promise<void> {
  try {
    if (!documentUrl) return;
    const order = await getOrderById(orderId);
    if (!order) return;
    const email = buildInvoiceReadyEmail({ order, documentUrl });
    if (!email) return;
    const res = await sendEmail(email);
    if (!res.ok) {
      void logError({
        source: 'server',
        route: '/api/seller/order-invoice',
        message: `Invoice-ready email failed: ${res.error ?? 'unknown'}`,
        statusCode: 502,
        actorRole: 'buyer',
        actorLabel: order.buyerEmail,
        resolutionHint: 'החשבונית נשמרה תקין והקונה רואה אותה באזור האישי, אבל לא נשלח לו מייל שהיא מוכנה.',
      });
    }
  } catch (err) {
    void logError({
      source: 'server',
      route: '/api/seller/order-invoice',
      message: `Invoice-ready email threw: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? err.stack : undefined,
      statusCode: 500,
      actorRole: 'buyer',
      resolutionHint: 'החשבונית נשמרה תקין; המייל לקונה נכשל.',
    });
  }
}
