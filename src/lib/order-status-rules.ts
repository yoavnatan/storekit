import type { Order } from './orders.js';

/**
 * What every order status MEANS, as one table.
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
}

export const SHIPPING_STATUS_RULES: Record<ShippingStatus, ShippingStatusRule> = {
  pending:    { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: false, buyerAwaiting: true,  blocksStoreClosure: true  },
  processing: { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: false, buyerAwaiting: true,  blocksStoreClosure: true  },
  ready:      { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: true , buyerAwaiting: true,  blocksStoreClosure: true  },
  shipped:    { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: false, terminal: false, notifiesBuyer: true , buyerAwaiting: true,  blocksStoreClosure: true  },
  delivered:  { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: false, terminal: false, notifiesBuyer: false, buyerAwaiting: false, blocksStoreClosure: false },
  cancelled:  { countsAsRevenue: false, holdsStock: false, cancellableFrom: false, terminal: true,  notifiesBuyer: true , buyerAwaiting: false, blocksStoreClosure: false },
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
}

export const PAYMENT_STATUS_RULES: Record<PaymentStatus, PaymentStatusRule> = {
  pending: { countsAsRevenue: false, awaitingOutcome: true , blocksStoreClosure: true  },
  paid:    { countsAsRevenue: true,  awaitingOutcome: false, blocksStoreClosure: true  },
  failed:  { countsAsRevenue: false, awaitingOutcome: false, blocksStoreClosure: false },
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

/** Both halves of `orderBlocksStoreClosure`. */
export const CLOSURE_BLOCKING_PAYMENT_STATUSES = paymentWhere('blocksStoreClosure');
export const CLOSURE_BLOCKING_SHIPPING_STATUSES = shippingWhere('blocksStoreClosure');

/** Does this order count toward money actually earned? Both halves must agree —
 *  see orders.ts#countsAsRevenue, which is the name the rest of the codebase uses. */
export function orderCountsAsRevenue(o: Pick<Order, 'paymentStatus' | 'shippingStatus'>): boolean {
  return PAYMENT_STATUS_RULES[o.paymentStatus]?.countsAsRevenue === true
    && SHIPPING_STATUS_RULES[o.shippingStatus]?.countsAsRevenue === true;
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
