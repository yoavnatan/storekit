import { businessDayISO, businessTodayISO, BUSINESS_TIMEZONE } from './business-day.js';
import { addDaysISO } from './date-range.js';
import {
  orderCountsAsRevenue,
  orderMoneyWasTaken,
  orderPayoutClockRuns,
  REVENUE_PAYMENT_STATUSES,
  REVENUE_SHIPPING_STATUSES,
  PAYOUT_CLOCK_SHIPPING_STATUSES,
  PICKUP_PAYOUT_CLOCK_SHIPPING_STATUSES,
} from './order-status-rules.js';
import { openReturnSql } from './returns.js';
import { HOLD_DAYS_AFTER_DELIVERY, FALLBACK_DAYS_AFTER_PAYMENT } from './payout-schedule.js';
import type { Order } from './orders.js';
import type { DeliveryMethod } from './shipping.js';

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
 * ── Why two clocks, and the gate in front of both ──
 * The delivery clock is the honest one: the return window starts when the buyer has the goods. But
 * it depends on a seller pressing a button, and a seller who never presses it would freeze their
 * own money forever and reasonably blame us. So there is a payment-based fallback.
 *
 * **Neither clock starts until the parcel has left** (`payoutClockRuns`). Without that gate the
 * fallback paid out orders the seller never touched — the hole the owner found on 2026-08-10.
 *
 * ⚠️ **A correction, recorded because the wrong version was said out loud and is worth not
 * re-deriving.** The fallback being LONGER than the delivery hold was justified as "reporting is
 * the faster path, so nobody games it by staying quiet". That is only true when the parcel arrives
 * within (fallback − hold) days: at 14 and 21, delivery on day 3 releases on 17 and silence
 * releases on 21, but delivery on day 12 releases on 26 while silence still releases on 21. On a
 * slow route, saying nothing pays sooner. The gate above removes the worst of it — you cannot get
 * paid without shipping at all — but it does not remove this, and the real fix is not a bigger
 * number: it is taking `delivered` from the COURIER's webhook rather than the seller's click
 * (GO_LIVE §5), after which there is nothing for the seller to withhold. Until then, pick the
 * fallback generously.
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
   *  rather than an unexplained date, and so a support question has an answer.
   *
   *  `'unshipped'` is the one that carries no date: the parcel has not left, so no clock has
   *  started. It is deliberately distinct from `null` (which means we could not date the order at
   *  all — an anomaly), because the two need opposite messages: one is "ship it and the countdown
   *  begins", the other is "something is wrong with this record".
   *
   *  `'return_open'` is the second dateless one, and it needs its own word for the same reason: the
   *  seller's screen has to say "a return case is open on this order" rather than leave him reading
   *  "ship it to start the countdown" about a parcel he shipped weeks ago. */
  basis: 'delivery' | 'payment' | 'unshipped' | 'return_open' | null;
}

/** The order fields this rule reads. A projection rather than a full `Order` so a query may select
 *  only these four columns, and so tests do not have to build an entire order to assert a date. */
export type HoldableOrder = Pick<Order, 'paymentStatus' | 'shippingStatus'> & {
  paidAt?: string | null;
  deliveredAt?: string | null;
  /** How the buyer gets it. Self-pickup never passes through `shipped`, so it reaches the payout
   *  gate one status earlier — `order-status-rules.ts`'s `pickupPayoutClockRuns` column. Absent
   *  takes the stricter courier answer, since orders predate the field. */
  deliveryMethod?: DeliveryMethod | null;
  /**
   * Is a return case open on this order (`return-requests.ts#hasOpenReturn`)?
   *
   * Absent means no, which is the right default for every caller that predates returns and for every
   * order that has never had one — and it is safe in the only direction that matters, because a
   * caller who forgets to pass it releases money on the ordinary schedule rather than freezing a
   * seller's funds on a case that does not exist.
   */
  hasOpenReturn?: boolean;
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

  // ── An open return case freezes this order's money (decisions §4) ──
  //
  // The owner's answer, and it is the cheap half of the protection: while a case is open the
  // platform is still HOLDING the money, so refusing to release it costs nothing and saves a
  // clawback nobody has to chase. Release it on schedule and a case that resolves the next day
  // becomes a debt against a seller who has already been paid.
  //
  // `held` rather than `not_payable`, and with no release date: nothing is lost — the moment the
  // case closes the ordinary clock applies and may release it the same day — but there is genuinely
  // no date to show, because it depends on something that has not happened yet. Same shape, and the
  // same reasoning, as the `unshipped` arm below.
  if (order.hasOpenReturn) return { state: 'held', releaseDayISO: null, basis: 'return_open' };

  // ── The parcel has to have LEFT before any clock starts ──
  //
  // The hole this closes, found by the owner on 2026-08-10 and it was real: the fallback clock
  // below releases money N days after payment so a seller who ships and never marks it delivered
  // does not freeze their own funds. But the two checks above are TRUE from `pending` onward — a
  // paid order that has not shipped is still revenue, correctly — so an order the seller never
  // touched at all sat on the same timer and paid out. **The platform paid for parcels that were
  // never sent, and nothing anywhere said so.**
  //
  // Not `not_payable`: nothing is lost and the seller can still ship tomorrow, at which point the
  // clock starts normally. It is `held` with NO release date, because there genuinely is no date
  // to show — the thing the date would depend on has not happened. `basis: 'unshipped'` is what
  // lets the seller's screen say "ship it to start the countdown" instead of showing a blank.
  //
  // ⚠️ What this does NOT solve: an order that is never shipped at all now holds the buyer's money
  // indefinitely. That is strictly better than paying the seller for it, and it is still wrong —
  // the buyer is owed a cancellation and a refund after some number of days. That mechanism does
  // not exist and the number is an owner decision (CURRENT_TASK §ג.11, with the returns policy).
  //
  // Self-pickup (owner, 2026-08-10, immediately after the above): a collected order has no shipping
  // leg at all and never reaches `shipped`, so gating on that alone froze a pickup order's money
  // until the seller remembered to press "נמסר" — and forever if they forgot. The delivery method
  // therefore picks the column, and `ready` is the milestone for pickup. See the column's doc.
  if (!orderPayoutClockRuns(order, order.deliveryMethod)) {
    return { state: 'held', releaseDayISO: null, basis: 'unshipped' };
  }

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
 * Parameter order is fixed by `releasableParams` below, so a caller cannot get it subtly wrong.
 *
 * ⚠️ **This predicate needs BOTH aliases: `o` for `orders` and `os` for `order_stores`.** The
 * delivery method lives on the per-store slice, not the order, so any query using this must join
 * `order_stores os`. That is not a burden in practice — every caller is already summing that
 * table's amounts.
 */
export const RELEASABLE_SQL = `
  o.payment_status = ANY($1::text[])
  AND o.shipping_status = ANY($2::text[])
  -- An open return case freezes this order's money, exactly as the JS half does (decisions §4).
  -- Written as NOT EXISTS rather than a join so an order with no case pays nothing for the rule, and
  -- so two cases on one order — which the partial unique index already forbids — could not double a
  -- row if it ever became possible.
  --
  -- The states are no longer spelled out here (2026-08-20). This is a template literal, so the one
  -- list in returns.ts generates them: openReturnSql is built FROM the same array isOpen tests, and
  -- the two cannot drift because there is only one of them. It had been hand-written in six places.
  -- tests/payout-hold.test.ts still runs the SQL and the TypeScript side by side.
  -- (No backticks in this comment either — see the note above.)
  AND NOT EXISTS (
        SELECT 1 FROM return_requests rr
         WHERE rr.order_id = o.id
           AND ${openReturnSql('rr.status')})
  -- The seller has to have done their part. ANDed with the revenue list rather than replacing it:
  -- revenue excludes a cancelled order, this excludes one that was never sent, and they are
  -- different questions. Both lists come off the status table, so a new status propagates here by
  -- filling in a row and never by someone remembering this string exists.
  --
  -- The CASE is the self-pickup milestone: a collected order never reaches 'shipped', so it uses
  -- the pickup list ('ready' and later). delivery_method is NULL on orders that predate the field,
  -- and a NULL = 'pickup' is NULL rather than true, so those fall to ELSE and take the stricter
  -- courier list — the same default the JS half applies for an absent method.
  -- (No backticks anywhere in this string: it is a template literal, and one would end it.)
  AND o.shipping_status = ANY(
        CASE WHEN os.delivery_method = 'pickup' THEN $8::text[] ELSE $7::text[] END)
  AND o.paid_at IS NOT NULL
  -- Prefilter on the RAW column so orders_payout_scan_idx stays in the plan. An order paid fewer
  -- than min(hold, fallback) days ago cannot be releasable under EITHER clock, so this excludes
  -- nothing the day arithmetic below would have kept — it is a necessary condition, not a second
  -- rule. Without it the date expression below is a function applied to the indexed column, which
  -- is the exact mistake order-reporting.ts's header documents having made and measured.
  AND o.paid_at <= now() - make_interval(days => LEAST($4::int, $5::int))
  -- ⚠️ THE FIRST ARM IS GUARDED BY ITS OWN NOT-NULL TEST, and that is a correctness requirement
  -- rather than a belt-and-braces habit. Without it, an order that has SHIPPED, has not been marked
  -- delivered, and is past the delivery hold but not yet past the fallback evaluates to
  -- NULL OR FALSE = NULL, and the whole predicate is NULL rather than FALSE.
  --
  -- Read positively that costs nothing: a FILTER (WHERE ...) and a WHERE both drop a NULL, so
  -- "released" was always right. It is the NEGATED readings that broke, and silently: NOT NULL is
  -- NULL, so getHeldBreakdown and getHeldBySeller dropped those rows from BOTH sides of their
  -- split — money that is unambiguously held, missing from the reason it is held for. The admin
  -- overview computes held as (total − released) and therefore still counted it, so the two screens
  -- reported different held totals with no error anywhere (owner, 2026-08-12: 239.36 apart).
  --
  -- The fix is here rather than a COALESCE at the two call sites on purpose. A predicate that
  -- decides whether money may move must be two-valued at its source; leaving it three-valued means
  -- every future negation is a fresh chance to lose a row, and there is nothing at a call site to
  -- suggest the guard is needed. Nothing else in the chain can produce NULL: a NULL paid_at is
  -- already FALSE by the conjunct above, and AND with a FALSE is FALSE whatever else is NULL.
  -- Pinned by "the predicate is never NULL" in tests/payout-hold.test.ts.
  AND (
        (o.delivered_at IS NOT NULL AND (o.delivered_at AT TIME ZONE $3)::date + $4::int <= ($6::date))
     OR (o.delivered_at IS NULL AND (o.paid_at AT TIME ZONE $3)::date + $5::int <= ($6::date))
      )`;

/**
 * The five payout states as SQL — the twin of `order-payout-line.ts#payoutFilterValue`, and the
 * reason it lives HERE rather than beside it: this is the second spelling of a rule, and every
 * second spelling in this file sits directly under the one it must agree with.
 *
 * It is what lets the ADMIN orders tab offer the same filter the seller's already has (owner,
 * 2026-08-11: *"יש פה אי-תאימות מסוימת ובלבול שלם"*). The seller's list is rendered client-side and
 * classifies each card in JS; the admin's is paginated in the database, so the same question has to
 * be askable in a `WHERE`. `tests/payout-hold.test.ts` runs both over every fixture order and fails
 * on any disagreement — without that, this is exactly the drift the file's header warns about.
 *
 * **The branch ORDER is the rule, and it mirrors `orderHold` exactly.** Not payable first; then
 * unshipped, which `orderHold` decides BEFORE any date arithmetic, so an unshipped order can never
 * report as released; then released; and only then the two flavours of waiting. The `paid_at IS
 * NOT NULL` guard on `undelivered` is not defensive — a captured order with no `paid_at` is held
 * with no basis at all in the JS, which `payoutFilterValue` reports as `window`, and this has to
 * land on the same word.
 *
 * Consumes `RELEASABLE_SQL`'s own parameters and nothing else, so a caller binds one list for both.
 * `$1`/`$2` are the revenue lists: `moneyWasTaken` is not tested separately because the two lists
 * are the same set today (both are exactly `paid`) — if a status ever counts as revenue without the
 * money having been taken, this needs its own arm and the parity test is what will say so.
 */
export const PAYOUT_CLASS_SQL = `CASE
  WHEN NOT (o.payment_status = ANY($1::text[]) AND o.shipping_status = ANY($2::text[])) THEN 'none'
  WHEN o.shipping_status <> ALL(
        CASE WHEN os.delivery_method = 'pickup' THEN $8::text[] ELSE $7::text[] END) THEN 'unshipped'
  WHEN ${RELEASABLE_SQL} THEN 'released'
  WHEN o.paid_at IS NOT NULL AND o.delivered_at IS NULL THEN 'undelivered'
  ELSE 'window'
END`;

/**
 * How many parameters `RELEASABLE_SQL` consumes — so a caller appending its OWN parameters says
 * `$${RELEASABLE_PARAM_COUNT + 1}` instead of a literal.
 *
 * Added after the count went from six to seven and silently broke both call sites: they had written
 * `$7` for their first extra argument, which now collided with this predicate's last one. The
 * failure was loud in a test and would have been a wrong `WHERE` in production — a predicate
 * comparing a uuid array against a list of shipping statuses. A positional parameter written as a
 * literal after a variable-length prefix is a number that goes stale the moment the prefix changes.
 */
export const RELEASABLE_PARAM_COUNT = 8;

/** The parameters `RELEASABLE_SQL` reads, in order. Built here so the SQL and its arguments cannot
 *  be assembled apart. `$6` (today) is supplied by the caller so a run and a report can be asked
 *  about the same day. */
export function releasableParams(todayISO: string = businessTodayISO()): readonly unknown[] {
  return [
    REVENUE_PAYMENT_STATUSES,
    REVENUE_SHIPPING_STATUSES,
    BUSINESS_TIMEZONE,
    HOLD_DAYS_AFTER_DELIVERY,
    FALLBACK_DAYS_AFTER_PAYMENT,
    todayISO,
    PAYOUT_CLOCK_SHIPPING_STATUSES,
    PICKUP_PAYOUT_CLOCK_SHIPPING_STATUSES,
  ];
}
