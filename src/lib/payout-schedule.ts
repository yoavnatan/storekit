/**
 * The payout POLICY — four numbers, and the single place they are allowed to exist.
 *
 * Under the agent model (AI_INSTRUCTIONS → Payment architecture) the platform collects the buyer's
 * payment on the seller's behalf, deducts the commission at source, and owes the seller the rest.
 * These constants answer the only two questions that arrangement raises: **when does the money stop
 * being at risk**, and **when do we actually send it**.
 *
 * ── Why a module rather than four literals ──
 * Each of these numbers has to appear in at least three places that must agree: the hold rule
 * (`payout-hold.ts`), the seller-facing screen, and the terms of use. A number written into a legal
 * clause and separately into a scheduler is a number that will disagree with itself, and the version
 * a seller can point at is the one in the terms. So `terms.astro` interpolates these constants
 * instead of restating them, and `tests/payout-schedule.test.ts` pins that the terms page contains
 * no bare digit for a period.
 *
 * ── ⚠️ PLACEHOLDERS, and which ones ──
 * `HOLD_DAYS_AFTER_DELIVERY` and `FALLBACK_DAYS_AFTER_PAYMENT` are NOT final. They are owner
 * decisions tied to the returns policy, which is itself still open (CURRENT_TASK §ג.11) — and the
 * two cannot be set independently: a hold shorter than the return window pays a seller for goods the
 * buyer may still send back, and the money is then gone. Same convention as the shipping prices in
 * `lib/shipping.ts`: a placeholder is named as one, in the code, so nobody later reads it as a
 * decision that was made. `PAYOUT_DAY_OF_MONTH` and `MIN_PAYOUT_AGOROT` are proposals awaiting the
 * same conversation.
 */

/**
 * How long a delivered order's money waits before it may be paid out.
 *
 * ⚠️ PLACEHOLDER — owner decision, must equal or exceed the returns window.
 */
export const HOLD_DAYS_AFTER_DELIVERY = 14;

/**
 * The backstop for an order the seller never marked delivered.
 *
 * Without one, a seller who simply does not touch the status dropdown freezes their own money
 * forever and blames the platform; with one set too short, "never mark it delivered" becomes the
 * fastest way to get paid. So it is deliberately LONGER than the delivery-based hold rather than
 * shorter — waiting is the penalty for not reporting, and reporting is the faster path.
 *
 * ⚠️ PLACEHOLDER — owner decision.
 */
export const FALLBACK_DAYS_AFTER_PAYMENT = 21;

/** Day of month the payout run builds payouts for everything released since the last run.
 *  ⚠️ PLACEHOLDER — owner decision. */
export const PAYOUT_DAY_OF_MONTH = 10;

/**
 * Below this, a payout is not sent and the balance rolls into the next period.
 *
 * Not a fee and not forfeiture: nothing is deducted and nothing expires, the transfer simply waits
 * until it is worth making. A bank transfer has a real per-transfer cost and a 4₪ payout costs more
 * to send than it moves.
 *
 * ⚠️ PLACEHOLDER — owner decision.
 */
export const MIN_PAYOUT_AGOROT = 10_000; // 100₪
