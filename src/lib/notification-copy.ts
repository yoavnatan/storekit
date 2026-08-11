/**
 * The titles stored on a message notification — Hebrew only, by construction.
 *
 * **Why these are not `translations.ts` keys.** A notification is written for somebody who is not
 * making the request: the row is INSERTed during the sender's POST and read hours later by the
 * recipient, out of the `title` column, verbatim. The only language in hand at write time is the
 * sender's cookie, and localising by that would be worse than not localising at all — an English
 * seller would get English or Hebrew depending on which shopper happened to write to them. The
 * platform stores no per-account language, so this is the same exemption
 * `tests/i18n-hardcoded-strings.test.ts` names for email templates: the recipient's language is not
 * known at send time. **If a per-account language is ever stored, this file is the one place to
 * change** — that is the point of it existing rather than the strings sitting inline.
 *
 * It also has to be a file that does not ask the dictionary for anything — not even in a comment,
 * since the guard reads the raw source. `/api/messages.ts` began asking on 2026-08-10 (the flood
 * refusals there DO go to the requester, whose language is known), and that guard is
 * file-granular and allowlist-free on purpose: the moment a file speaks two languages, every
 * literal in it is held to that standard. Splitting on the real distinction — copy for the asker
 * vs copy for a stranger — is the answer that guard is asking for, not an escape from it.
 *
 * The same sentence was previously written twice inside that route, which is the ordinary reason a
 * second copy drifts.
 */

/** A buyer opened a thread, or replied inside one, and the SELLER is being told. */
export const NOTIFY_NEW_MESSAGE_FROM_BUYER = 'יש לך הודעה חדשה מקונה';

/** A seller replied, and the BUYER is being told. */
export const NOTIFY_NEW_MESSAGE_FROM_SELLER = 'יש לך הודעה חדשה ממוכר';
