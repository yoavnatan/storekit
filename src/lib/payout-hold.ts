import { businessDayISO, businessTodayISO, BUSINESS_TIMEZONE } from './business-day.js';
import { addDaysISO } from './date-range.js';
import {
  orderCountsAsRevenue,
  orderMoneyWasTaken,
  REVENUE_PAYMENT_STATUSES,
  REVENUE_SHIPPING_STATUSES,
} from './order-status-rules.js';
import { HOLD_DAYS_AFTER_DELIVERY, FALLBACK_DAYS_AFTER_PAYMENT } from './payout-schedule.js';
import type { Order } from './orders.js';

/**
 * WHEN a seller's share of an order stops being at risk and may be paid out.
 *
 * Under the agent model the platform holds the buyer's money on the seller's behalf
 * (AI_INSTRUCTIONS → Payment architecture). Between the charge and the payout sits the only window
 * in which a refund, a cancellation or a chargeback can still be settled out of money we actually
 * have. Once we have sent it, a reversal becomes a debt to chase — `seller_ledger_adjustments`
 * exists for that case precisely because it cannot be prevented entirely, only made rare. **The
 * hold is the mechanism that makes it rare, so the rule that decides it lives alone in one pure
 * module with no I/O and no config beyond the two constants.**
 *
 * ── The three answers, and why "not payable" is not the same as "held" ──
 * `held` means the clock is running and a date can be shown to the seller. `not_payable` means no
 * clock will ever run, and showing a release date for one would be a promise of money that is not
 * coming. The seller's screen renders those differently, so the distinction is in the type rather
 * than in a nullable date every caller has to interpret.
 *
 * ── Why it asks the status table and never the words ──
 * `orderCountsAsRevenue` and `orderMoneyWasTaken` are the two columns in `order-status-rules.ts`
 * that this question actually needs, and going through them is what makes a FUTURE status correct
 * for free: a `returned` or `refused` status is added by filling in a row there, and this file
 * inherits the right answer without anyone remembering it exists. A bare
 * `shippingStatus === 'cancelled'` here would be the third place in the codebase to redefine what
 * cancelled means, which is the exact bug `order-status-rules.ts` was extracted to end.
 *
 * ── Why two clocks ──
 * The delivery clock is the honest one: the return window starts when the buyer has the goods. But
 * it depends on a seller pressing a button, and a seller who never presses it would freeze their
 * own money forever and reasonably blame us. So there is a payment-based fallback — and it is
 * deliberately LONGER, not shorter. If it were shorter, "never mark it delivered" would be the
 * fastest route to getting paid, and the delivery status the whole fulfilment pipeline depends on
 * would quietly rot.
 *
 * Everything here is a business-calendar DAY, not an instant: `businessDayISO` for the event and
 * plain calendar arithmetic on top (the composition `visitor-retention.ts` already uses). Israel is
 * UTC+2/+3, so a UTC day boundary would release money on the wrong date for every order placed
 * between midnight and 02:00 — the class of bug `business-day.ts` was written to end.
 */

export type HoldState =
  /** No payout will ever come from this order — cancelled, refunded, or never captured. */
  | 'not_payable'
  /** The clock is running. `releaseDayISO` says when it ends. */
  | 'held'
  /** The hold has expired; this is owed to the seller now. */
  | 'releasable';

export interface OrderHold {
  state: HoldState;
  /** Business day the money becomes releasable, or null when `state` is 'not_payable'. */
  releaseDayISO: string | null;
  /** Which clock decided it — carried so the seller's screen can say "14 days from delivery"
   *  rather than an unexplained date, and so a support question has an answer. */
  basis: 'delivery' | 'payment' | null;
}

/** The order fields this rule reads. A projection rather than a full `Order` so a query may select
 *  only these four columns, and so tests do not have to build an entire order to assert a date. */
export type HoldableOrder = Pick<Order, 'paymentStatus' | 'shippingStatus'> & {
  paidAt?: string | null;
  deliveredAt?: string | null;
};

/**
 * The whole rule.
 *
 * `todayISO` is a parameter with a default rather than a `new Date()` inside, so every case in
 * `tests/payout-hold.test.ts` is a plain assertion about two dates instead of a clock mock — and so
 * the payout job and the seller's screen can be asked the same question about the same day and
 * cannot disagree about when "today" is.
 */
export function orderHold(order: HoldableOrder, todayISO: string = businessTodayISO()): OrderHold {
  const notPayable: OrderHold = { state: 'not_payable', releaseDayISO: null, basis: null };

  // Money never moved — a pending or failed capture owes the seller nothing. Asked of the status
  // table, because "was money taken" and "does it count as revenue" are two different columns and
  // this needs both: the first rules out uncaptured orders, the second rules out captured ones that
  // have since been cancelled.
  if (!orderMoneyWasTaken(order)) return notPayable;
  if (!orderCountsAsRevenue(order)) return notPayable;

  // A captured order with no `paid_at` cannot be dated, and dating it from something else would be
  // guessing with a seller's money. It stays held rather than releasable — the safe direction — and
  // the reconciliation surfaces it as an anomaly rather than this file inventing a day.
  if (!order.paidAt) return { state: 'held', releaseDayISO: null, basis: null };

  const basis: 'delivery' | 'payment' = order.deliveredAt ? 'delivery' : 'payment';
  const fromDay = businessDayISO(new Date(basis === 'delivery' ? order.deliveredAt! : order.paidAt));
  const days = basis === 'delivery' ? HOLD_DAYS_AFTER_DELIVERY : FALLBACK_DAYS_AFTER_PAYMENT;
  const releaseDayISO = addDaysISO(fromDay, days);

  // Inclusive: on the release day itself the money is out of hold. A seller told "released on the
  // 24th" who sees it still held on the 24th has been told the wrong date, and the alternative
  // (exclusive) makes every displayed date off by one in the direction the seller notices.
  return {
    state: releaseDayISO <= todayISO ? 'releasable' : 'held',
    releaseDayISO,
    basis,
  };
}

/** Convenience for the balance sum, which only ever asks the one question. */
export function isReleasable(order: HoldableOrder, todayISO: string = businessTodayISO()): boolean {
  return orderHold(order, todayISO).state === 'releasable';
}

/**
 * ── The SQL half of the same rule ──
 *
 * The payout run cannot load every order on the platform into JS to ask this question one row at a
 * time — that is a sum over a table that grows with every sale, run for every seller, and it is the
 * shape `feedback_scalability` exists to stop. So the run aggregates in the database, and the rule
 * therefore has to exist in SQL too.
 *
 * **Two spellings of one rule is the arrangement that drifts**, so this follows the precedent
 * `checkout-group.ts` set for exactly this problem: both spellings live in ONE module, next to each
 * other, so a change to one is a visible omission in the other rather than a discovery made months
 * later by a number that disagrees with itself. `tests/payout-hold.test.ts` runs the same cases
 * through both and asserts they agree, which is the part that makes the arrangement safe rather
 * than merely tidy.
 *
 * What is NOT re-implemented here: the status rule. `REVENUE_PAYMENT_STATUSES` and
 * `REVENUE_SHIPPING_STATUSES` are derived from `order-status-rules.ts`'s table and passed in as
 * parameters, so a new status still fills in one row there and both halves inherit it. A literal
 * `shipping_status <> 'cancelled'` in this string would have been the third definition of cancelled
 * in the codebase.
 *
 * Parameter order is fixed by `RELEASABLE_PARAMS` below, so a caller cannot get it subtly wrong.
 */
export const RELEASABLE_SQL = `
  o.payment_status = ANY($1::text[])
  AND o.shipping_status = ANY($2::text[])
  AND o.paid_at IS NOT NULL
  -- Prefilter on the RAW column so orders_payout_scan_idx stays in the plan. An order paid fewer
  -- than min(hold, fallback) days ago cannot be releasable under EITHER clock, so this excludes
  -- nothing the day arithmetic below would have kept — it is a necessary condition, not a second
  -- rule. Without it the date expression below is a function applied to the indexed column, which
  -- is the exact mistake order-reporting.ts's header documents having made and measured.
  AND o.paid_at <= now() - make_interval(days => LEAST($4::int, $5::int))
  AND (
        (o.delivered_at AT TIME ZONE $3)::date + $4::int <= ($6::date)
     OR (o.delivered_at IS NULL AND (o.paid_at AT TIME ZONE $3)::date + $5::int <= ($6::date))
      )`;

/** The six parameters `RELEASABLE_SQL` reads, in order. Built here so the SQL and its arguments
 *  cannot be assembled apart. `$6` (today) is supplied by the caller so a run and a report can be
 *  asked about the same day. */
export function releasableParams(todayISO: string = businessTodayISO()): readonly unknown[] {
  return [
    REVENUE_PAYMENT_STATUSES,
    REVENUE_SHIPPING_STATUSES,
    BUSINESS_TIMEZONE,
    HOLD_DAYS_AFTER_DELIVERY,
    FALLBACK_DAYS_AFTER_PAYMENT,
    todayISO,
  ];
}
