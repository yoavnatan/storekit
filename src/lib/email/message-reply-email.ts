import { logError } from '../error-log.js';
import { renderEmailShell, esc } from './template.js';
import { sendEmail } from './index.js';

/**
 * A seller's reply to somebody who has no account to read it in.
 *
 * ── The hole this closes (found 2026-08-19, reading the six inquiry paths end to end) ──
 * Guest checkout is the default here, so the "יש לי שאלה על ההזמנה" link in every order mail is
 * used mostly by people with no account. Their question lands in the seller's inbox correctly and
 * the seller can type an answer — and that answer went **nowhere**. The reply notified
 * `from_user_id`, which for a guest is the synthetic `order:<id>`: a `notifications` row no login
 * can ever reach. Meanwhile the form's own success screen promised *"המוכר יענה לכם במייל שאיתו
 * בוצעה ההזמנה"*. A promise the code did not keep is worse than no channel at all — the buyer waits
 * instead of phoning, and the seller believes they have answered.
 *
 * So a reply to a guest goes out as MAIL, to the address the order was placed with. That address is
 * already on the message row (`from_email`, written by `/api/order-message` from the order itself,
 * never from the request), so nothing new is trusted here.
 *
 * ── What this is NOT ──
 * Not a mailing list and not a conversation. It carries the seller's words and the order's
 * reference, and it sets `replyTo` to the SELLER — so a guest hitting "reply" in their own mail
 * client reaches the person who answered them, which is the only continuation that can work
 * without an account. There is deliberately no link back into the site: the thread lives in an
 * inbox the guest cannot open, and a link to a login wall is an insult to somebody who was told
 * they did not need one.
 *
 * ── Until SMTP exists ──
 * `sendEmail` falls to the console adapter without `RESEND_API_KEY` (GO_LIVE §4), so today this
 * prints instead of sending. That is the same state every other mail on the platform is in, and
 * the day the key is set in the host's settings this starts delivering with nothing to change.
 * The success-screen copy is true of the system as designed; §4 is what makes it true of the
 * system as running.
 */

export interface MessageReplyMail {
  /** The address the order was placed with — from the message row, not from a request. */
  to: string;
  /** Who is answering, as the shopper knows them: the store's name. */
  storeName: string;
  /** The seller's own address, so "reply" in a mail client reaches a person. */
  replyTo: string;
  /** The human order reference, when the thread has one in its subject. */
  subject: string;
  body: string;
}

export function buildMessageReplyEmail(input: MessageReplyMail): { subject: string; html: string; text: string } {
  const heading = `תשובה מ${input.storeName}`;
  const subject = input.subject.trim() || heading;
  const html = renderEmailShell({
    previewText: input.body.slice(0, 120),
    heading,
    // `white-space: pre-line` so the seller's own line breaks survive — a reply retyped as one
    // block reads as a form letter, which is the opposite of what a person just wrote by hand.
    bodyHtml: `<p style="margin:0 0 1rem;white-space:pre-line">${esc(input.body)}</p>`
      + `<p style="margin:0;font-size:0.85rem;color:#5a6478">אפשר להשיב למייל הזה והתשובה תגיע ישירות ל${esc(input.storeName)}.</p>`,
  });
  return { subject, html, text: `${input.body}\n\n— ${input.storeName}` };
}

/**
 * Send it, and never let it break the reply that triggered it.
 *
 * The message is already written and committed by the time this runs; a mail provider having a bad
 * minute must not turn a successful reply into an error the seller sees and retries, which would
 * post the reply twice. Failures are logged where the admin's Alerts tab shows them — the same
 * shape `order-confirmation.ts` uses, and for the same reason.
 */
export async function sendMessageReplyEmail(input: MessageReplyMail): Promise<void> {
  try {
    const mail = buildMessageReplyEmail(input);
    const result = await sendEmail({ to: input.to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: input.replyTo });
    if (!result.ok) {
      await logError({
        source: 'server',
        route: 'notify:message-reply',
        message: `Guest reply mail failed: ${result.error ?? 'unknown'}`,
        resolutionHint: 'A seller answered a guest and the answer did not leave the building. The guest has no account, so mail is the ONLY way it can reach them.',
      });
    }
  } catch (err) {
    await logError({
      source: 'server',
      route: 'notify:message-reply',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
