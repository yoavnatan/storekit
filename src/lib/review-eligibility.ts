import type { Order, OrderItem } from './orders.js';
import { PAYMENT_STATUS_RULES, SHIPPING_STATUS_RULES, type PaymentStatus, type ShippingStatus } from './order-status-rules.js';

/**
 * Who may review what — the single answer, asked by the API, by the product page and by the
 * review page, so none of them can be more generous than the others.
 *
 * ── THE DECISION: a review needs a verified purchase, and does NOT need a password ──
 * (owner asked, 2026-08-17: "מתלבט אם חייב להתחבר כדי להוסיף ביקורת".)
 *
 * Requiring an ACCOUNT and requiring a PURCHASE look like the same gate and are not. An account is
 * free, takes twenty seconds and proves nothing — a seller can open six of them and rate their own
 * catalogue, and a competitor can do the arithmetic in the other direction. A purchase cannot be
 * faked: it costs the price of the goods, it is a row in `orders` with money against it, and it is
 * the only fact on this platform that says "this person actually has the product".
 *
 * So an account is not required and a purchase is. What that buys, in order of how much it matters:
 *
 *   1. **The ad accounts.** There is ONE Merchant Center and ONE Meta catalog for the whole
 *      platform (memory `project_ad_platform_account_risk`), and Google's Product Ratings policy
 *      treats fabricated reviews as a policy violation against the ACCOUNT. An open review box is
 *      one motivated seller away from every seller's ads going down at once. Nothing else in this
 *      feature is worth that risk.
 *   2. **The reviews are worth reading**, which is the entire product value. "Verified purchase"
 *      is not a badge here — it is the only kind of review that exists.
 *   3. **Guests still review**, and they are most of the buyers: guest checkout is the default
 *      (AI_INSTRUCTIONS → Checkout), so a login wall would have silently excluded the majority and
 *      left the feature permanently empty. The proof travels in a signed link instead
 *      (`order-token.ts`) — no password, no account, one tap from the email.
 *
 * The cost is honest and worth stating: nobody can review a product they did not buy HERE, so the
 * catalogue starts at zero and fills at the rate the platform actually sells. That is the correct
 * trade — and it is why the launch checklist carries Google's 50-review threshold as a real
 * milestone rather than a switch to flip (GO_LIVE §2.7).
 */

/** One purchased line the buyer is allowed to say something about. */
export interface ReviewableLine {
  productId: string;
  productName: string;
  productSlug: string;
  storeSlug: string;
  storeName: string;
  image?: string;
}

/**
 * Is this ORDER at a point where its buyer may review what is in it?
 *
 * Both halves, and the shipping half is a COLUMN rather than a status comparison
 * (`order-status-rules.ts#buyerMayReview`) — a cancelled order still says `paymentStatus: 'paid'`,
 * which is the trapdoor a bare payment check falls through.
 *
 * **Takes plain strings, on purpose.** The buyer dashboard renders its order card twice — server-
 * side from an `Order`, and in JavaScript from the JSON `/api/buyer/orders` sent back — and the
 * second one holds statuses that have been through `JSON.parse` and are `string` to the compiler.
 * Narrowing the parameter would have left that renderer writing its own status comparison, which is
 * the second definition this whole table exists to prevent. An unknown status is FALSE rather than
 * a crash: a value neither side recognises is not one to publish a review from.
 */
export function orderIsReviewable(order: { paymentStatus: string; shippingStatus: string }): boolean {
  const payment = PAYMENT_STATUS_RULES[order.paymentStatus as PaymentStatus];
  const shipping = SHIPPING_STATUS_RULES[order.shippingStatus as ShippingStatus];
  return !!payment?.countsAsRevenue && !!shipping?.buyerMayReview;
}

/**
 * The lines of one order that may still be reviewed, given what has already been written.
 *
 * De-duplicated by product: an order holding the same product twice (two variants of one shirt) is
 * one thing the buyer owns and one opinion, which is also what the `UNIQUE (order_id, product_id)`
 * constraint enforces one layer down. A line whose `productId` is empty — the product was deleted
 * since — drops out rather than offering a review with nothing to attach it to.
 */
export function reviewableLines(
  order: Pick<Order, 'paymentStatus' | 'shippingStatus' | 'items'>,
  alreadyReviewedProductIds: readonly string[] = [],
): ReviewableLine[] {
  if (!orderIsReviewable(order)) return [];
  const done = new Set(alreadyReviewedProductIds);
  const seen = new Set<string>();
  const lines: ReviewableLine[] = [];
  for (const item of order.items) {
    if (!item.productId || done.has(item.productId) || seen.has(item.productId)) continue;
    seen.add(item.productId);
    lines.push(toLine(item));
  }
  return lines;
}

function toLine(item: OrderItem): ReviewableLine {
  const line: ReviewableLine = {
    productId: item.productId,
    productName: item.productName,
    productSlug: item.productSlug,
    storeSlug: item.storeSlug,
    storeName: item.storeName,
  };
  if (item.image) line.image = item.image;
  return line;
}

/**
 * May this order be reviewed for THIS product — the check the write endpoint runs.
 *
 * Deliberately separate from `reviewableLines`: that one builds a screen and may be as clever as
 * it likes, this one is the authorization decision and reads only the order it was handed. An id
 * arriving in a request body is a claim, never a permission (memory
 * `project_checkout_idempotency_ownership`), so the product must be IN the order — not merely
 * exist, and not merely belong to the same store.
 */
export function orderCoversProduct(
  order: Pick<Order, 'paymentStatus' | 'shippingStatus' | 'items'>,
  productId: string,
): boolean {
  if (!productId || !orderIsReviewable(order)) return false;
  return order.items.some((item) => item.productId === productId);
}
