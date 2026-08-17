import { createNotification } from './notifications.js';
import { sendEmail } from './email/index.js';
import { renderEmailShell, esc } from './email/template.js';
import { ctaButton, SITE } from './email/parts.js';
import { formatAgorot } from './money.js';
import type { Order } from './orders.js';
import type { ReturnRequest } from './return-requests.js';
import type { ReturnStatus } from './returns.js';

/**
 * Who hears about a return, and through which channel — decisions §7, and nothing more than it says.
 *
 * ── The two rules the owner set, and they pull in opposite directions ──
 * The buyer gets a MAIL on approval or refusal and on the credit, and on nothing else: *"לא בכל
 * שינוי"*. The seller gets an in-app NOTIFICATION on a new request and before his clock runs out.
 * Neither list is "every transition", and that restraint is the feature — a channel that fires on
 * everything is one people stop reading, and the messages here are the ones that must arrive.
 *
 * ── Why the buyer gets mail and the seller does not ──
 * The buyer may not be on the site at all; the request was a thing they did once and then waited on,
 * and an answer that lives only behind a login is an answer they will find days late. The seller is
 * in the dashboard daily by construction — it is where his shop is run from — so a notification with
 * a badge on the tab reaches him just as fast without spending the one channel that interrupts.
 * (The same reasoning `returns-run.ts` records for its dispute alert, applied to a smaller event.)
 *
 * ── Every function here swallows its own failure ──
 * Each is called AFTER the thing it announces has already been persisted. A mail provider that is
 * down must not roll back an approval or leave a request half-moved — the rule `settleStatusChange`
 * states, applied here for the same reason. Failures are logged by the adapter, not by pretending.
 */

/** The buyer-facing sentence for each state that earns a message. Absent = no message, which is
 *  most of them: `in_transit` and `received` are the mechanism working, not news the buyer can act
 *  on, and `expired` is the buyer's own inaction and already visible on their order. */
const BUYER_COPY: Partial<Record<ReturnStatus, { title: string; body: (r: ReturnRequest) => string }>> = {
  approved: {
    title: 'בקשת ההחזרה אושרה',
    body: (r) => `שלח את המוצר בחזרה, ונזכה אותך ב-${formatAgorot(r.refundAgorot)} כשהוא יגיע.`,
  },
  rejected: {
    title: 'בקשת ההחזרה לא אושרה',
    body: (r) => r.sellerNote
      ? `המוכר לא אישר את ההחזרה. הסיבה: ${r.sellerNote}`
      : 'המוכר לא אישר את ההחזרה.',
  },
  refunded: {
    // "אושר", not "בוצע" — the money has not moved yet and will not until a payment provider is
    // wired (GO_LIVE §3). A buyer told their refund is done, who then finds nothing on their card,
    // calls their bank; that chargeback is the thing this whole mechanism exists to make
    // unnecessary. The obligation is real and worth announcing — only the tense was wrong.
    title: 'ההחזר אושר',
    body: (r) => `${formatAgorot(r.refundAgorot)} יוחזרו לכרטיס שבו שילמת.`,
  },
};

/**
 * Tell the buyer where their request stands — notification and, for these three states, a mail.
 *
 * A guest checkout has no account, so `buyerId` is absent and there is nothing to notify; the mail
 * still goes, because the address is on the order and it is the only way to reach them at all.
 */
export async function notifyBuyerReturnStatus(
  request: ReturnRequest,
  order: Pick<Order, 'buyerId' | 'buyerEmail' | 'buyerName' | 'checkoutRef' | 'id'>,
  storeName?: string,
): Promise<void> {
  const copy = BUYER_COPY[request.status];
  if (!copy) return;
  const body = copy.body(request);

  if (order.buyerId) {
    try {
      await createNotification({
        userId: order.buyerId,
        role: 'buyer',
        type: 'order_update',
        title: copy.title,
        body,
        relatedId: request.orderId,
        ...(storeName ? { storeName } : {}),
      });
    } catch { /* announced, not load-bearing — see the header */ }
  }

  if (order.buyerEmail) {
    try {
      const ref = order.checkoutRef ?? order.id.slice(0, 8);
      // A mail that says what happened and not where to look is a mail that ends in a search
      // (owner, 2026-08-17: *"הקונה מקבל מייל ששולח אותו לאנשהו באתר? הפירוט יהיה לו איפה?"*). The
      // button lands on the buyer's own orders tab, which is where the request, its status and the
      // amount already live — so the mail carries the news and the site carries the detail, and
      // neither has to restate the other.
      const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(order.buyerName ?? '')},</p>
<p style="margin:0 0 12px;">${esc(body)}</p>
<p style="margin:0 0 12px;color:#6b7280;">הזמנה ${esc(ref)}</p>
${ctaButton(`${SITE}/buyer/dashboard?tab=orders`, 'לפרטי ההזמנה')}`;
      await sendEmail({
        to: order.buyerEmail,
        subject: `${copy.title} (${ref})`,
        html: renderEmailShell({ previewText: body, heading: copy.title, bodyHtml }),
        text: `שלום ${order.buyerName ?? ''},\n${body}\nהזמנה ${ref}`,
      });
    } catch { /* same */ }
  }
}

/**
 * Tell the seller a request has arrived.
 *
 * Only when it is HIS to answer — inside the statutory window the request was approved on arrival and
 * he has no decision to make, so the message would be an interruption that ends in "and there is
 * nothing for you to do". He still sees it on his tab, with its own badge, which is where a thing
 * that needs no answer belongs.
 */
export async function notifySellerReturnOpened(
  sellerId: string,
  request: ReturnRequest,
  storeName?: string,
): Promise<void> {
  try {
    await createNotification({
      userId: sellerId,
      role: 'seller',
      type: 'order_update',
      title: request.withinStatutory ? 'התקבלה בקשת החזרה' : 'בקשת החזרה מחכה לתשובתך',
      body: request.withinStatutory
        // Said plainly, because a seller who thinks he is being asked to decide will look for a
        // button that is not there — and the law, not the platform, is what removed it.
        ? `הקונה ביקש להחזיר מוצר בתוך 14 הימים הראשונים, ולכן הבקשה אושרה אוטומטית. תראה אותה בלשונית "החזרות".`
        : `הקונה ביקש להחזיר מוצר אחרי חלון ההחזרה. ההחלטה שלך — יש לך יומיים לענות.`,
      relatedId: request.orderId,
      storeSlug: request.storeSlug,
      ...(storeName ? { storeName } : {}),
    });
  } catch { /* announced, not load-bearing */ }
}

/**
 * Tell the seller his clock is nearly out — one message, one day before it closes on him.
 *
 * Sent by the daily sweep and only for the states where silence has a COST he did not choose: a
 * request he may still refuse, and a parcel sitting unopened that will refund itself. Not for the
 * handover window, which is the buyer's to miss.
 */
export async function notifySellerReturnDeadline(
  sellerId: string,
  request: ReturnRequest,
  what: 'answer' | 'open_parcel',
): Promise<void> {
  try {
    await createNotification({
      userId: sellerId,
      role: 'seller',
      type: 'order_update',
      title: what === 'answer' ? 'בקשת החזרה — היום היום האחרון לענות' : 'המוצר חזר אליך ומחכה לך',
      body: what === 'answer'
        // Why he MAY refuse, then what happens if he says nothing, then the thing he might actually
        // want: silence works in his favour here, so a warning that only states the default has
        // nothing in it for him.
        ? 'הקונה ביקש להחזיר מוצר אחרי שחלף חלון ההחזרה, ולכן ההחלטה שלך. היום היום האחרון לענות. אם לא תענה, הבקשה תידחה והקונה לא יקבל כסף בחזרה. אם רצית לאשר את ההחזרה — זה היום.'
        // He already marked it as arrived; the missing step is saying what condition it is in.
        // Deliberately does NOT list the answers. Naming "ריק ומשומש" in a reminder teaches the
        // option to a seller who had not considered it, and it is the one claim in this mechanism
        // that nothing can verify (owner, 2026-08-17: "לא מזמין בעיות?"). The button is still on the
        // card for the seller who genuinely needs it; the nudge only names the step he owes.
        : 'המוצר חזר אליך ועוד לא סימנת שבדקת אותו. אם לא תסמן מחר, הקונה יקבל את כספו בחזרה והסכום יקוזז מהתשלום הבא שלך.',
      relatedId: request.orderId,
      storeSlug: request.storeSlug,
    });
  } catch { /* announced, not load-bearing */ }
}
