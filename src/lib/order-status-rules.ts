import type { Order } from './orders.js';
import type { DeliveryMethod } from './shipping.js';

/**
 * What every order status MEANS, as one table.
 *
 * **One row per status, one column per consequence — a new status FILLS A ROW, never adds a new
 * `if` at a call site.** (Stated here from 2026-08-06; it was a line in AI_INSTRUCTIONS, which is
 * not where you are standing when you add a status.)
 *
 * The bug this exists to prevent has already happened here twice, in the same
 * shape: a status was added or reinterpreted, and only some of the code that cares
 * got updated. 'cancelled' was counted as revenue for seven sessions because
 * cancelling leaves paymentStatus at 'paid' and each revenue module carried its own
 * `=== 'paid'` copy of the rule. The "units sold" counter had the same gap, and it
 * reached further than a dashboard column — into the storefront's popularity
 * ordering and into `custom_label_1` in the Merchant/Meta feed, where phantom units
 * pulled real ad budget.
 *
 * Grepping for every reader of a field works only if you remember to do it. A table
 * does not depend on remembering: adding a status means adding a row, and a row has
 * a column for every consequence, so the compiler asks the questions instead of a
 * reviewer having to think of them. tests/order-status-rules.test.ts asserts the
 * table covers every status in the Order type, so a new status cannot be added
 * without landing here first.
 *
 * Add a facet as a COLUMN, never as a fresh `if` at a call site. That is the same
 * mistake in a new costume.
 */

export type ShippingStatus = Order['shippingStatus'];
export type PaymentStatus = Order['paymentStatus'];

export interface ShippingStatusRule {
  /** Can this status ever be part of money that counts? 'cancelled' cannot: the
   *  charge happened, but the goods went back on the shelf and the money is owed
   *  back. Combined with the payment rule below by countsAsRevenue(). */
  countsAsRevenue: boolean;
  /** Are the order's units still committed to it? False means stock has been
   *  returned, so anything that re-returns it would oversell. */
  holdsStock: boolean;
  /** May the seller still cancel from here? Once the parcel is moving, no. */
  cancellableFrom: boolean;
  /** No transitions out. Guards the "un-cancel an order whose stock is gone" move. */
  terminal: boolean;
  /** Does reaching this status tell the buyer anything? Mirrors the copy table in
   *  order-status-copy.ts — internal work states and redundant ones stay quiet. */
  notifiesBuyer: boolean;
  /** Is the BUYER still waiting on this? What splits their order list into "פעילות" and
   *  "היסטוריה" (buyer-purchases.ts). Deliberately its own column and not a reading of
   *  `blocksStoreClosure`, which they currently agree with to the row: that one asks whether
   *  the SELLER still owes work, and the two come apart the moment a status exists that the
   *  seller is done with and the buyer is not — a returns window, say. Until 2026-08-05 this
   *  was a bare `=== 'delivered'` at the dashboard, which is why a cancelled order sat in
   *  "active" forever with nothing left to happen to it. */
  buyerAwaiting: boolean;
  /** Does this order still owe the buyer something, so the store may not finish closing while
   *  it exists (store-lifecycle.ts)? A buyer who paid must get their goods — the seller may
   *  stop SELLING the moment they want (that is what pausing is for), but walking away from a
   *  parcel that is still their responsibility is not an operational choice. 'shipped' still
   *  counts: it is moving, and the seller is the one who marks it arrived. */
  blocksStoreClosure: boolean;
  /**
   * Has the parcel actually LEFT the seller — so the payout clock may run?
   *
   * Its own column, and the reason is a hole this table was asked to close (2026-08-10, owner:
   * *"he can just never send the product, and the money still goes to him?"* — and it did).
   * `payout-hold.ts` has a fallback clock: an order nobody marked delivered releases N days after
   * payment, so a seller who ships and then never touches the status dropdown does not freeze their
   * own money forever. That rule read `countsAsRevenue`, which is TRUE from `pending` onward — so
   * an order the seller never touched at all released on the same timer. **The platform paid for
   * parcels that were never sent.**
   *
   * `countsAsRevenue` could not have answered this: a paid order that has not shipped yet IS
   * revenue — the sale happened, the money is real, every report is right to count it. "Is this a
   * sale" and "has the seller done enough to be paid for it" are different questions, and this is
   * the second one.
   *
   * `ready` is FALSE, and it is the row worth pausing on: the seller has packed the parcel and
   * printed a label, which feels like having done the work. It is not — the parcel is still on
   * their table, and a status the seller sets alone must never start a clock that ends in a
   * transfer. `shipped` means it is with the courier and moving, which is the first point anyone
   * outside the seller can corroborate. ⚠️ And it is still the SELLER who sets `shipped` today;
   * the honest source is the courier's webhook (GO_LIVE §5), which is why this column is a floor
   * and not the whole answer.
   */
  payoutClockRuns: boolean;
  /**
   * The same question for an order the buyer COLLECTS — where the answer is different by one row.
   *
   * Self-pickup has no shipping leg: nothing is ever handed to a courier, so the order goes
   * `pending → processing → ready → delivered` and never touches `shipped`. Under
   * `payoutClockRuns` alone, a pickup order's money would therefore be frozen until the seller
   * remembered to press "נמסר" after the buyer walked out — and if they forgot, frozen forever.
   * That is the same freeze the fallback clock exists to prevent, arriving through a different door.
   *
   * So for pickup, **`ready` is the milestone**: it is the last thing the seller controls. After it
   * the parcel is packed and waiting and the remaining step belongs to the buyer, exactly as
   * `shipped` means the remaining step belongs to the courier.
   *
   * **Why the weaker evidence is acceptable here and not for a courier order.** `ready` is a status
   * the seller sets with nothing corroborating it — the objection that keeps it FALSE in the column
   * above. It is much weaker for pickup: the buyer physically turns up at the shop, so an order
   * marked ready with nothing behind it produces a person standing at the counter that day, not a
   * silent non-delivery discovered weeks later. The fallback hold still has to elapse on top.
   */
  pickupPayoutClockRuns: boolean;
}

export const SHIPPING_STATUS_RULES: Record<ShippingStatus, ShippingStatusRule> = {
  pending:    { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: false, buyerAwaiting: true,  blocksStoreClosure: true,  payoutClockRuns: false, pickupPayoutClockRuns: false },
  processing: { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: false, buyerAwaiting: true,  blocksStoreClosure: true,  payoutClockRuns: false, pickupPayoutClockRuns: false },
  ready:      { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: true , buyerAwaiting: true,  blocksStoreClosure: true,  payoutClockRuns: false, pickupPayoutClockRuns: true  },
  shipped:    { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: false, terminal: false, notifiesBuyer: true , buyerAwaiting: true,  blocksStoreClosure: true,  payoutClockRuns: true , pickupPayoutClockRuns: true  },
  delivered:  { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: false, terminal: false, notifiesBuyer: false, buyerAwaiting: false, blocksStoreClosure: false, payoutClockRuns: true , pickupPayoutClockRuns: true  },
  cancelled:  { countsAsRevenue: false, holdsStock: false, cancellableFrom: false, terminal: true,  notifiesBuyer: true , buyerAwaiting: false, blocksStoreClosure: false, payoutClockRuns: false, pickupPayoutClockRuns: false },
};

export interface PaymentStatusRule {
  /** Did money actually arrive? Only 'paid' may contribute to any revenue figure. */
  countsAsRevenue: boolean;
  /** Is this order's outcome still unknown? A pending order is neither a sale nor a
   *  non-sale, and showing it as either is a lie in one direction or the other. */
  awaitingOutcome: boolean;
  /** Same question as the shipping column, from the money side: does the store still owe
   *  something here? A failed payment owes nothing — nobody paid — so it must not hold a
   *  closure open forever. A pending one does: its outcome is unknown, and closing the store
   *  out from under an order that is about to be confirmed is the worse of the two mistakes. */
  blocksStoreClosure: boolean;
  /**
   * Has money actually LEFT the buyer's card?
   *
   * Not the same question as `countsAsRevenue`, and the difference is what `refund-owed.ts` is
   * built on: revenue asks "does this order earn anyone anything today", and the answer flips back
   * to false the moment it is cancelled. This asks "was a real person's money taken", and the
   * answer never flips back — once captured, it is either kept or given back, and something has to
   * say which. A cancelled paid order scores `false` on the first column and `true` on this one,
   * which is precisely the state where the buyer is owed money.
   *
   * `pending` is false because the checkout writes the order rows BEFORE the capture (payment.ts):
   * at that instant the gateway is holding the amount and has not been told to take it.
   */
  moneyWasTaken: boolean;
}

export const PAYMENT_STATUS_RULES: Record<PaymentStatus, PaymentStatusRule> = {
  pending: { countsAsRevenue: false, awaitingOutcome: true , blocksStoreClosure: true , moneyWasTaken: false },
  paid:    { countsAsRevenue: true,  awaitingOutcome: false, blocksStoreClosure: true , moneyWasTaken: true  },
  failed:  { countsAsRevenue: false, awaitingOutcome: false, blocksStoreClosure: false, moneyWasTaken: false },
};

/** Statuses a seller may move an order TO — everything the UI offers. */
export const CANCELLABLE_FROM: ShippingStatus[] = (Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[])
  .filter((s) => SHIPPING_STATUS_RULES[s].cancellableFrom);

/**
 * The same columns as lists, for the queries that have to ask this question in SQL.
 *
 * A `WHERE payment_status = 'paid' AND shipping_status <> 'cancelled'` inside a query is a second
 * copy of the table — the exact thing the table exists to prevent, just written in another
 * language, where no compiler and no `tests/order-status-rules.test.ts` can see it. Derived here
 * and passed in as a parameter, a new status row propagates into every query that reads it, and a
 * status the table says nothing about cannot silently answer "yes" to a SQL predicate.
 */
const shippingWhere = (column: keyof ShippingStatusRule): ShippingStatus[] =>
  (Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]).filter((s) => SHIPPING_STATUS_RULES[s][column]);
const paymentWhere = (column: keyof PaymentStatusRule): PaymentStatus[] =>
  (Object.keys(PAYMENT_STATUS_RULES) as PaymentStatus[]).filter((s) => PAYMENT_STATUS_RULES[s][column]);

/** Both halves of `orderCountsAsRevenue`, as the two lists a query ANDs together. */
export const REVENUE_PAYMENT_STATUSES = paymentWhere('countsAsRevenue');
export const REVENUE_SHIPPING_STATUSES = shippingWhere('countsAsRevenue');

/**
 * The fulfilment pipeline in order — what "sort by status" means on the admin Orders tab, in both
 * the JS twin and the SQL that replaced it (`admin-orders-filter.ts`, `orders.ts`).
 *
 * DERIVED, never re-listed: the table's own row order IS the pipeline, and `cancelled` drops out
 * because it is the one status the pipeline does not pass through (`terminal`). A hand-written
 * `['pending','processing',…]` beside a sort is a second copy of this file, which is the exact
 * thing `tests/money-guards.test.ts` refuses — and a new status added as a row would not appear
 * in it.
 */
export const SHIPPING_PIPELINE_ORDER: ShippingStatus[] =
  (Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]).filter((s) => !SHIPPING_STATUS_RULES[s].terminal);

/** The shipping statuses from which a payout clock may run (`payoutClockRuns`), for the SQL half of
 *  the hold rule in `payout-hold.ts`. ANDed with the revenue lists, never instead of them: a
 *  cancelled order is excluded by revenue, an unshipped one by this. */
export const PAYOUT_CLOCK_SHIPPING_STATUSES = shippingWhere('payoutClockRuns');

/** The same list for an order the buyer collects — `ready` and later. See the column's own doc
 *  for why self-pickup has a different milestone and why weaker evidence is acceptable there. */
export const PICKUP_PAYOUT_CLOCK_SHIPPING_STATUSES = shippingWhere('pickupPayoutClockRuns');

/**
 * Has the seller done everything they control, so money may release on a timer?
 *
 * Asked of the table rather than compared against 'shipped'/'delivered' — the whole reason the
 * table exists — and it takes the DELIVERY METHOD because the milestone genuinely differs: a
 * courier order needs `shipped`, a collected one needs `ready`. Passing the method in and picking a
 * column keeps both answers in the table; an `if (method === 'pickup')` at the call site would be a
 * second definition of the pipeline living next to the payout rule.
 *
 * An unknown or absent method takes the stricter courier answer. Orders predate the field
 * (`StoreSubtotal.deliveryMethod` is optional for backward compatibility), and defaulting the other
 * way would release an old order's money a status early.
 */
export function orderPayoutClockRuns(
  o: Pick<Order, 'shippingStatus'>,
  deliveryMethod?: DeliveryMethod | null,
): boolean {
  const rule = SHIPPING_STATUS_RULES[o.shippingStatus];
  if (!rule) return false;
  return deliveryMethod === 'pickup' ? rule.pickupPayoutClockRuns : rule.payoutClockRuns;
}

/** Both halves of `orderBlocksStoreClosure`. */
export const CLOSURE_BLOCKING_PAYMENT_STATUSES = paymentWhere('blocksStoreClosure');
export const CLOSURE_BLOCKING_SHIPPING_STATUSES = shippingWhere('blocksStoreClosure');

/** Does this order count toward money actually earned? Both halves must agree —
 *  see orders.ts#countsAsRevenue, which is the name the rest of the codebase uses. */
export function orderCountsAsRevenue(o: Pick<Order, 'paymentStatus' | 'shippingStatus'>): boolean {
  return PAYMENT_STATUS_RULES[o.paymentStatus]?.countsAsRevenue === true
    && SHIPPING_STATUS_RULES[o.shippingStatus]?.countsAsRevenue === true;
}

/** Was this order's money really captured? The column above says why this is a separate question
 *  from `orderCountsAsRevenue`, and `refund-owed.ts` is the caller it exists for. */
export function orderMoneyWasTaken(o: Pick<Order, 'paymentStatus'>): boolean {
  return PAYMENT_STATUS_RULES[o.paymentStatus]?.moneyWasTaken === true;
}

/** Are this order's units still off the shelf? Reads the table rather than testing
 *  for 'cancelled', so a future "returned" status only has to fill in a row. */
export function orderHoldsStock(o: Pick<Order, 'shippingStatus'>): boolean {
  return SHIPPING_STATUS_RULES[o.shippingStatus]?.holdsStock === true;
}

/** Is this order still an open obligation on its store? Both halves must agree — a paid parcel
 *  in transit is open, a cancelled one is not, and a failed payment never was. Read the table
 *  rather than listing statuses, so a future status only has to fill in its row. */
export function orderBlocksStoreClosure(o: Pick<Order, 'paymentStatus' | 'shippingStatus'>): boolean {
  return PAYMENT_STATUS_RULES[o.paymentStatus]?.blocksStoreClosure === true
    && SHIPPING_STATUS_RULES[o.shippingStatus]?.blocksStoreClosure === true;
}

/** Is this transition allowed? The two rules the orders API enforces, in one place. */
export function canTransition(from: ShippingStatus, to: ShippingStatus): { ok: true } | { ok: false; reason: string } {
  // Terminal is checked BEFORE the no-op case, so re-cancelling an already-cancelled
  // order is refused rather than quietly succeeding. It looks harmless today (the
  // restock is guarded separately), but a 200 on a repeat cancel is an invitation to
  // whatever runs downstream of one — and once refunds are real, that is a second
  // refund. tests/seller-orders-cancel.test.ts pins this.
  if (SHIPPING_STATUS_RULES[from]?.terminal) {
    return { ok: false, reason: 'Order is cancelled and cannot change status' };
  }
  // Setting a live order to the status it already has is a no-op, not an error — a
  // repeat request from a second dashboard tab must not 409.
  if (from === to) return { ok: true };
  if (to === 'cancelled' && !SHIPPING_STATUS_RULES[from]?.cancellableFrom) {
    return { ok: false, reason: 'Order can no longer be cancelled' };
  }
  return { ok: true };
}
