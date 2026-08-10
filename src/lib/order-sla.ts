import { businessDayISO, businessTodayISO } from './business-day.js';
import { addDaysISO } from './date-range.js';
import { orderCountsAsRevenue, orderMoneyWasTaken, orderPayoutClockRuns } from './order-status-rules.js';
import { SHIP_WARNING_DAYS, SHIP_AUTO_CANCEL_DAYS } from './payout-schedule.js';
import type { HoldableOrder } from './payout-hold.js';

/**
 * How long the seller has to do their part — and what happens when they do not.
 *
 * ── The hole this closes ──
 * `payout-hold.ts` refuses to pay a seller who never shipped, which was right and was only half an
 * answer: the buyer's money then sat with the platform indefinitely. Not paid out, not refunded,
 * with nothing anywhere saying so. The owner put it plainly — *"what happens if nobody reports
 * anything?"* — and the honest answer was "we keep it forever". This module is the other half.
 *
 * ── Why the deadline is on the seller's OWN milestone ──
 * It is the same line `order-status-rules.ts` already draws for the payout clock: `shipped` for a
 * courier order, `ready` for self-pickup. That is deliberate and it is a fairness rule, not a
 * convenience — once a courier integration exists, the seller's last controllable act is handing
 * the parcel over, and a courier that fails to collect must never produce a warning aimed at the
 * seller. Reusing `orderPayoutClockRuns` means the two questions cannot drift apart: whatever
 * counts as "the seller did their part" for money counts as it for the deadline too.
 *
 * ── Why nothing here is deducted from the buyer ──
 * Cancelling for non-supply is precisely the case in which a business may charge no cancellation
 * fee and must collect the goods itself (תקנות הגנת הצרכן (ביטול עסקה) תשע"א-2010, as summarised on
 * kolzchut — checked 2026-08-10, not recalled). Nothing was supplied here, so the buyer is made
 * whole and the platform absorbs nothing it had not already collected.
 *
 * Pure and day-based, like `payout-hold.ts`, and for the same reason: the day a warning fires has
 * to be assertable in a test without a clock, and the business calendar is the only calendar this
 * platform has.
 */

export type FulfilmentState =
  /** Nothing owed — never paid, already cancelled, or the seller has done their part. */
  | 'ok'
  /** Late, and the seller should be told. */
  | 'warn'
  /** Long enough that the order should be cancelled and the buyer refunded. */
  | 'overdue';

export interface FulfilmentStatus {
  state: FulfilmentState;
  /** Business day the seller's part was due. Null when the question does not apply. */
  dueDayISO: string | null;
  /** Business day this becomes cancellable. Null when the question does not apply. */
  cancelDayISO: string | null;
}

const NONE: FulfilmentStatus = { state: 'ok', dueDayISO: null, cancelDayISO: null };

/**
 * Is this order late, and how late?
 *
 * `todayISO` is a parameter with a default for the same reason `orderHold` takes one — the job, a
 * report and a test must be able to ask about the same day and cannot be allowed to disagree.
 */
export function fulfilmentStatus(
  order: HoldableOrder,
  todayISO: string = businessTodayISO(),
): FulfilmentStatus {
  // Money never moved, or the order is already out of the running. Nothing is owed either way, and
  // asking the status table rather than the word 'cancelled' is what makes a future `returned`
  // status inherit the right answer.
  if (!orderMoneyWasTaken(order) || !orderCountsAsRevenue(order)) return NONE;

  // The seller has done their part — whatever that means for this delivery method. From here the
  // order belongs to the courier or to the buyer, and neither is the seller's to be warned about.
  if (orderPayoutClockRuns(order, order.deliveryMethod)) return NONE;

  // Undatable rather than late. The same conservative branch `orderHold` takes: a captured order
  // with no `paid_at` gets no clock invented for it, and reconcile reports the anomaly.
  if (!order.paidAt) return NONE;

  const paidDay = businessDayISO(new Date(order.paidAt));
  const dueDayISO = addDaysISO(paidDay, SHIP_WARNING_DAYS);
  const cancelDayISO = addDaysISO(paidDay, SHIP_AUTO_CANCEL_DAYS);

  // Inclusive, like the hold rule: on the cancel day itself it is cancellable. A seller told "this
  // is cancelled on the 14th" and finding it alive on the 14th has been shown the wrong date.
  if (cancelDayISO <= todayISO) return { state: 'overdue', dueDayISO, cancelDayISO };
  if (dueDayISO <= todayISO) return { state: 'warn', dueDayISO, cancelDayISO };
  return { state: 'ok', dueDayISO, cancelDayISO };
}
