/**
 * "This message was written by somebody with no account" — the one definition, and the reason it
 * is its own file.
 *
 * `messages.from_user_id` is plain `text` on purpose, so it can hold a value that is not an account
 * id: a guest who asked about their own order from the signed link in an order mail. The prefix
 * below is a NAMESPACE, not an id — it keeps the thread attributable to the order without inventing
 * an account for a person who deliberately did not make one.
 *
 * **Three places have to agree about it**, and they cannot all import each other:
 *   · `/api/order-message` writes it;
 *   · `/api/messages` reads it to choose between an in-app notification and a letter — a
 *     notification addressed to this value is a row no login can ever open;
 *   · `seller-messages-query.ts` reads it to tell the SELLER that their reply will travel by post,
 *     and that module is bundled into the browser.
 *
 * That last one is why this is not in `messages.ts`: that module opens a database connection at
 * import time, and `tests/client-bundle-no-db.test.ts` fails any file under `src/scripts/` whose
 * import graph reaches one. A predicate over a string has no business dragging a connection pool
 * into a page, and duplicating it into the client would be the second definition this file exists
 * to prevent.
 */

export const GUEST_SENDER_PREFIX = 'order:';

/** Does this sender have an account that could receive an in-app notification? */
export function senderHasAccount(fromUserId: string): boolean {
  return !!fromUserId && !fromUserId.startsWith(GUEST_SENDER_PREFIX);
}
