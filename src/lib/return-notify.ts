import { createNotification } from './notifications.js';
import { sendEmail } from './email/index.js';
import { renderEmailShell, esc } from './email/template.js';
import { ctaButton, SITE } from './email/parts.js';
import { orderHelpUrl } from './order-token.js';
import { formatAgorot } from './money.js';
import type { Order } from './orders.js';
import type { ReturnRequest } from './return-requests.js';
import { returnedGoods, returnedGoodsCount, type ReturnedGoods, type ReturnStatus } from './returns.js';

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

/**
 * What actually came back, in words that survive being wrong about the count.
 *
 * These messages used to open *"המוצר חזר אליך"* — one product, definite, as if the seller already
 * knew which. He does not: nothing here names an item or an order, and the owner was explicit that
 * this is fine (2026-08-23: *"לא ברור איזה מוצר או איזו הזמנה, וזה בסדר"*). What is not fine is the
 * article and the number — a definite "המוצר" promises an antecedent the sentence never gives, and
 * a return may hold several lines or a whole order (*"ואולי בכלל מדובר במוצרים?"* — it may).
 *
 * The table itself is `returns.ts#returnedGoods`, shared with the seller's card, which had exactly
 * the same singular in exactly the same sentences.
 */
function returnedSubject(request: ReturnRequest): ReturnedGoods {
  // 0 when the whole order came back: nothing here has read the order, so counting its lines is not
  // available and "ההזמנה" is the true thing to say. `returnedGoods` states that contract.
  return returnedGoods(returnedGoodsCount(request.returnedLines));
}

/** The buyer-facing sentence for each state that earns a message. Absent = no message: `in_transit`
 *  and `received` are the mechanism working, not news the buyer can act on. */
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
  // ── The two closures that end AGAINST the buyer, added because they now exist ──
  //
  // `expired` used to be dismissed here as "the buyer's own inaction and already visible on their
  // order", and that reasoning does not survive the two new ways in: an offer he never answered, and
  // a handover window he may simply have lost track of. A case that closes and takes the money with
  // it is the single most important thing that can happen to a person on this screen, and "it is
  // visible if you go and look" is exactly how somebody learns about it a month too late.
  expired: {
    title: 'בקשת ההחזרה נסגרה',
    // Deliberately does not accuse: from here we cannot tell a lost parcel from a change of heart
    // from a person who was in hospital. What he needs is what it MEANS and what he can still do.
    body: () => 'הבקשה נסגרה והמוצר לא הוחזר, ולכן לא בוצע החזר כספי. אם תקופת ההחזרה עוד לא חלפה, אפשר לפתוח בקשה חדשה מהאזור האישי.',
  },
  disputed: {
    title: 'הבקשה עברה לבדיקה שלנו',
    // Says who decides and that nobody has been paid, and says nothing about the seller's claim. His
    // rule from the first round, and it holds harder here: an accusation is not made on a screen.
    body: () => 'הבקשה עברה לבדיקה שלנו ואנחנו נכריע בה. עד ההכרעה הכסף לא מועבר לאף צד. נעדכן אותך כשתהיה החלטה.',
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
${ctaButton(`${SITE}/buyer/dashboard?tab=orders`, 'לפרטי ההזמנה')}
<!-- The decision mail is exactly where a buyer most wants to say something back, and a GUEST has
     no dashboard to be sent to — that button is a dead link for them. The same neutral door as
     every other mail: deliberately not "לא מסכים?", which puts them opposite the seller before
     they have said anything (owner, 2026-08-17). A refused case does not block a new one. -->
<p style="margin:16px 0 0;font-size:13px;"><a href="${orderHelpUrl(SITE, order.id)}" style="color:#5a6478;">פנייה בנוגע להזמנה</a></p>`;
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
 * Tell the buyer his own clock runs out tomorrow.
 *
 * ── Why this exists at all ──
 * Every warning in this mechanism used to go to the seller, and the handover window was written off as
 * "the buyer's to miss". That was true and it was not a reason: the buyer is the one who loses the
 * money, he is the party who is not in a dashboard daily, and the two clocks that can close on him
 * (the handover window, and an offer he has not answered) both end with a case shut and nothing paid.
 * One sentence the day before is what separates a deadline from a trap.
 *
 * Reuses the buyer mail shape rather than inventing a second one, for the reason this file's header
 * gives: a mail that says what happened and not where to look ends in a search.
 */
export async function notifyBuyerReturnDeadline(
  order: Pick<Order, 'buyerId' | 'buyerEmail' | 'buyerName' | 'checkoutRef' | 'id'>,
  which: 'handover' | 'offer',
  storeName?: string,
): Promise<void> {
  const title = which === 'handover' ? 'מחר היום האחרון לשלוח את המוצר' : 'מחר היום האחרון לענות להצעה';
  const body = which === 'handover'
    // What to do, by when, and what happens otherwise — in that order, and with the way back out: a
    // closed request is not the end of his right, and a buyer who thinks it is will not try again.
    ? 'אם לא ישלח המוצר בחזרה לחנות עד מחר, הבקשה תיסגר ולא יבוצע החזר כספי. שלחת כבר? סמן באזור האישי שהמוצר נשלח, וזה עוצר את הסגירה.'
    : 'המוכר הציע החזר כספי חלקי במקום שהמוצר יחזור, ומחר ההצעה מתבטלת. אפשר לקבל אותה או לדחות ולהחזיר את המוצר כרגיל — שתי האפשרויות באזור האישי.';

  if (order.buyerId) {
    try {
      await createNotification({
        userId: order.buyerId, role: 'buyer', type: 'order_update',
        title, body, relatedId: order.id,
        ...(storeName ? { storeName } : {}),
      });
    } catch { /* announced, not load-bearing — see the header */ }
  }
  if (order.buyerEmail) {
    try {
      const ref = order.checkoutRef ?? order.id.slice(0, 8);
      const bodyHtml = `
<p style="margin:0 0 12px;">שלום ${esc(order.buyerName ?? '')},</p>
<p style="margin:0 0 12px;">${esc(body)}</p>
<p style="margin:0 0 12px;color:#6b7280;">הזמנה ${esc(ref)}</p>
${ctaButton(`${SITE}/buyer/dashboard?tab=orders`, 'לפרטי ההזמנה')}
<p style="margin:16px 0 0;font-size:13px;"><a href="${orderHelpUrl(SITE, order.id)}" style="color:#5a6478;">פנייה בנוגע להזמנה</a></p>`;
      await sendEmail({
        to: order.buyerEmail,
        subject: `${title} (${ref})`,
        html: renderEmailShell({ previewText: body, heading: title, bodyHtml }),
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
      // `return_update`, not `order_update` — the type is what picks the tab the click opens
      // (notification-link.ts), and this one belongs to "החזרות". Under `order_update` the body
      // below told the seller to go and look at the returns tab while the click itself took him
      // to Orders.
      type: 'return_update',
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
 * request he may still refuse, a parcel sitting unopened that will refund itself, and a parcel the
 * buyer says he posted which is about to become our decision instead of his. Not for the handover
 * window, which is the buyer's to miss — and which the buyer is now warned about himself.
 */
export async function notifySellerReturnDeadline(
  sellerId: string,
  request: ReturnRequest,
  what: 'answer' | 'open_parcel' | 'missing_parcel',
): Promise<void> {
  const subject = returnedSubject(request);
  try {
    await createNotification({
      userId: sellerId,
      role: 'seller',
      // See `notifySellerReturnOpened` — this is the one the owner clicked, and it landed on
      // Orders.
      type: 'return_update',
      title: what === 'answer' ? 'בקשת החזרה — היום היום האחרון לענות'
        : what === 'missing_parcel' ? `הקונה מסר שהוא שלח את ${subject.the} — ${subject.arrived} אליך?`
        : `${subject.cameBackToYou} ו${subject.waitsForYou}`,
      body: what === 'missing_parcel'
        // Both answers, plainly, because either one may be the true one and he is the only person who
        // knows which. Naming what happens if he says nothing is the point: the case leaves his hands.
        //
        // It no longer QUOTES the button. It used to say press *"המוצר הגיע אליי"* verbatim, and
        // that label is itself per-card now (ReturnsPanel#goods) — so on a three-item return the
        // message named a control that says something else. Describing the action survives a
        // relabelling; quoting one does not.
        ? `אם ${subject.the} ${subject.arrived} אליך — סמן בלשונית ההחזרות שקיבלת ${subject.it}. אם לא, אל תסמן כלום. מחר הבקשה תעבור לבדיקה שלנו ואנחנו נכריע בה, והכסף יישאר מוקפא עד ההכרעה.`
        : what === 'answer'
        // Why he MAY refuse, then what happens if he says nothing, then the thing he might actually
        // want: silence works in his favour here, so a warning that only states the default has
        // nothing in it for him.
        ? 'הקונה ביקש להחזיר מוצר אחרי שחלף חלון ההחזרה, ולכן ההחלטה שלך. היום היום האחרון לענות. אם לא תענה, הבקשה תידחה והקונה לא יקבל כסף בחזרה. אם רצית לאשר את ההחזרה — זה היום.'
        // He already marked it as arrived; the missing step is saying what condition it is in.
        // Deliberately does NOT list the answers. Naming "ריק ומשומש" in a reminder teaches the
        // option to a seller who had not considered it, and it is the one claim in this mechanism
        // that nothing can verify (owner, 2026-08-17: "לא מזמין בעיות?"). The button is still on the
        // card for the seller who genuinely needs it; the nudge only names the step he owes.
        : `${subject.cameBackToYou} ועוד לא סימנת שבדקת ${subject.it}. אם לא תסמן מחר, הקונה יקבל את כספו בחזרה והסכום יקוזז מהתשלום הבא שלך.`,
      relatedId: request.orderId,
      storeSlug: request.storeSlug,
    });
  } catch { /* announced, not load-bearing */ }
}
