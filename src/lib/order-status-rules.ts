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
}

export const SHIPPING_STATUS_RULES: Record<ShippingStatus, ShippingStatusRule> = {
  pending:    { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: false },
  processing: { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: false },
  ready:      { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: true,  terminal: false, notifiesBuyer: true  },
  shipped:    { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: false, terminal: false, notifiesBuyer: true  },
  delivered:  { countsAsRevenue: true,  holdsStock: true,  cancellableFrom: false, terminal: false, notifiesBuyer: false },
  cancelled:  { countsAsRevenue: false, holdsStock: false, cancellableFrom: false, terminal: true,  notifiesBuyer: true  },
};

export interface PaymentStatusRule {
  /** Did money actually arrive? Only 'paid' may contribute to any revenue figure. */
  countsAsRevenue: boolean;
  /** Is this order's outcome still unknown? A pending order is neither a sale nor a
   *  non-sale, and showing it as either is a lie in one direction or the other. */
  awaitingOutcome: boolean;
}

export const PAYMENT_STATUS_RULES: Record<PaymentStatus, PaymentStatusRule> = {
  pending: { countsAsRevenue: false, awaitingOutcome: true  },
  paid:    { countsAsRevenue: true,  awaitingOutcome: false },
  failed:  { countsAsRevenue: false, awaitingOutcome: false },
};

/** Statuses a seller may move an order TO — everything the UI offers. */
export const CANCELLABLE_FROM: ShippingStatus[] = (Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[])
  .filter((s) => SHIPPING_STATUS_RULES[s].cancellableFrom);

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
