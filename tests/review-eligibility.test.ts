import { describe, it, expect } from 'vitest';
import { orderIsReviewable, reviewableLines, orderCoversProduct } from '../src/lib/review-eligibility.js';
import { SHIPPING_STATUS_RULES, PAYMENT_STATUS_RULES, REVIEWABLE_SHIPPING_STATUSES, type ShippingStatus } from '../src/lib/order-status-rules.js';
import { orderToken, verifyOrderToken, reviewInviteUrl } from '../src/lib/order-token.js';
import crypto from 'node:crypto';
import { requiredSecret } from '../src/lib/runtime-env.js';

/**
 * Who may publish a review — the gate the whole feature rests on.
 *
 * The verified-purchase decision is argued in `review-eligibility.ts`. What is asserted here is the
 * part that can silently rot: that the rule is still READ FROM THE STATUS TABLE and has not become
 * a status comparison somewhere, and that each of the three ways in still refuses what it should.
 */

const ITEM = {
  productId: 'p-1', productName: 'אגרטל', productSlug: 'agartal',
  storeSlug: 'keramika', storeName: 'קרמיקה', priceAgorot: 9900, qty: 1,
};
const order = (over: Partial<{ paymentStatus: string; shippingStatus: string; items: typeof ITEM[] }> = {}) => ({
  paymentStatus: 'paid',
  shippingStatus: 'delivered',
  items: [ITEM],
  ...over,
}) as never;

describe('the shipping half comes from the table, not from a status name', () => {
  it('agrees with `buyerMayReview` for every status the type allows', () => {
    // The assertion that matters: if someone adds a status and fills the row, this passes with no
    // edit; if someone writes `=== 'delivered'` at a call site instead, it fails here.
    for (const status of Object.keys(SHIPPING_STATUS_RULES) as ShippingStatus[]) {
      expect(orderIsReviewable(order({ shippingStatus: status })))
        .toBe(SHIPPING_STATUS_RULES[status].buyerMayReview);
    }
  });

  it('lets a shipped, a delivered and a RETURNED order through', () => {
    // A buyer who sent it back has the most informed opinion on the platform. A review system that
    // silences exactly the unhappy buyers is not a review system.
    for (const status of ['shipped', 'delivered', 'returned']) {
      expect(orderIsReviewable(order({ shippingStatus: status }))).toBe(true);
    }
  });

  it('refuses everything before the parcel left', () => {
    for (const status of ['pending', 'processing', 'ready']) {
      expect(orderIsReviewable(order({ shippingStatus: status }))).toBe(false);
    }
  });

  it('refuses a CANCELLED order even though it is still `paid` — the trapdoor', () => {
    // This is why the check is two columns and not `paymentStatus === 'paid'`: cancelling does not
    // touch the payment status, so a bare payment check would have opened the whole catalogue of
    // cancelled orders to review.
    expect(PAYMENT_STATUS_RULES.paid.countsAsRevenue).toBe(true);
    expect(orderIsReviewable(order({ shippingStatus: 'cancelled' }))).toBe(false);
  });

  it('refuses an unpaid or failed order at any shipping status', () => {
    expect(orderIsReviewable(order({ paymentStatus: 'pending' }))).toBe(false);
    expect(orderIsReviewable(order({ paymentStatus: 'failed' }))).toBe(false);
  });

  it('refuses a status nobody recognises rather than throwing on it', () => {
    // The buyer dashboard's client twin hands this JSON-parsed strings.
    expect(orderIsReviewable({ paymentStatus: 'paid', shippingStatus: 'teleported' })).toBe(false);
    expect(orderIsReviewable({ paymentStatus: '', shippingStatus: '' })).toBe(false);
  });

  it('publishes the same list to SQL as it answers in JS', () => {
    // `REVIEWABLE_SHIPPING_STATUSES` is what the invite job and the product page's eligibility
    // query narrow on. A list that drifted from the column would show a form the API then refuses.
    expect([...REVIEWABLE_SHIPPING_STATUSES].sort()).toEqual(['delivered', 'returned', 'shipped']);
  });
});

describe('which lines the review page offers', () => {
  it('offers each purchased product once', () => {
    const two = order({ items: [ITEM, { ...ITEM, productId: 'p-2', productName: 'צלחת' }] });
    expect(reviewableLines(two).map((l) => l.productId)).toEqual(['p-1', 'p-2']);
  });

  it('de-duplicates one product bought twice in the same order', () => {
    // Two variants of one shirt are one thing the buyer owns and one opinion — which is also what
    // the UNIQUE (order_id, product_id) constraint enforces one layer down.
    const twice = order({ items: [ITEM, { ...ITEM }] });
    expect(reviewableLines(twice)).toHaveLength(1);
  });

  it('drops what has already been reviewed', () => {
    expect(reviewableLines(order(), ['p-1'])).toEqual([]);
  });

  it('drops a line whose product no longer exists', () => {
    expect(reviewableLines(order({ items: [{ ...ITEM, productId: '' }] }))).toEqual([]);
  });

  it('offers nothing at all from an order that may not be reviewed', () => {
    expect(reviewableLines(order({ shippingStatus: 'cancelled' }))).toEqual([]);
  });
});

describe('a product id in a request body is a claim, never a permission', () => {
  it('accepts a product that is a line in the order', () => {
    expect(orderCoversProduct(order(), 'p-1')).toBe(true);
  });

  it('refuses a product that merely exists', () => {
    // Without this, one valid order id would authorise reviewing the whole catalogue.
    expect(orderCoversProduct(order(), 'p-999')).toBe(false);
    expect(orderCoversProduct(order(), '')).toBe(false);
  });

  it('refuses even a real line when the order is not reviewable', () => {
    expect(orderCoversProduct(order({ shippingStatus: 'pending' }), 'p-1')).toBe(false);
  });
});

describe('the guest link proves one order and nothing else', () => {
  const ORDER_A = '00000000-0000-4000-8000-00000000000a';
  const ORDER_B = '00000000-0000-4000-8000-00000000000b';

  it('verifies the order it was minted for', () => {
    expect(verifyOrderToken(ORDER_A, 'review', orderToken(ORDER_A, 'review'))).toBe(true);
  });

  it('does not verify any other order', () => {
    expect(verifyOrderToken(ORDER_B, 'review', orderToken(ORDER_A, 'review'))).toBe(false);
  });

  it('refuses a missing, empty or non-string token', () => {
    expect(verifyOrderToken(ORDER_A, 'review', '')).toBe(false);
    expect(verifyOrderToken(ORDER_A, 'review', undefined)).toBe(false);
    expect(verifyOrderToken(ORDER_A, 'review', 42)).toBe(false);
    expect(verifyOrderToken('', 'review', orderToken(ORDER_A, 'review'))).toBe(false);
  });

  it('is namespaced, so no other signature on this site can be replayed as one', () => {
    // Every HMAC here derives its own key from AUTH_SECRET (`::csrf`, `::handoff`, `::admin`,
    // `::review`). Signed with the bare secret — or with another module's namespace — the same
    // order id produces a different token, which is what stops one signature being spent as
    // another.
    const secret = requiredSecret('AUTH_SECRET', 'dev-insecure-secret');
    const bare = crypto.createHmac('sha256', secret).update(ORDER_A).digest('base64url').slice(0, 32);
    const otherNs = crypto.createHmac('sha256', `${secret}::csrf`).update(ORDER_A).digest('base64url').slice(0, 32);
    expect(verifyOrderToken(ORDER_A, 'review', bare)).toBe(false);
    expect(verifyOrderToken(ORDER_A, 'review', otherNs)).toBe(false);
  });

  it('builds a link with exactly one slash between origin and path', () => {
    expect(reviewInviteUrl('https://dezabin.co.il/', ORDER_A))
      .toBe(`https://dezabin.co.il/review/${ORDER_A}?t=${orderToken(ORDER_A, 'review')}`);
  });
});
