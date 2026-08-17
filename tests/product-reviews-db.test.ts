import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { APIContext, AstroCookies } from 'astro';
import { POST as checkout } from '../src/pages/api/checkout.js';
import { POST as postReview } from '../src/pages/api/review.js';
import { query, firstRow } from '../src/lib/db.js';
import { getOrderById, updateOrder } from '../src/lib/orders.js';
import {
  createReview, getReviewsForProduct, getProductRating, setReviewBlocked,
  getReviewedProductIds, getReviewableOrderForProduct, countPublishedReviews,
} from '../src/lib/product-reviews.js';
import { reviewToken } from '../src/lib/review-token.js';

/**
 * The review write path, against a real database.
 *
 * Two things are asserted here and nowhere else, because neither can be tested without one:
 *
 *   1. **The cached score never disagrees with the reviews.** `store_products.review_count` /
 *      `review_rating_sum` are a cache of `product_reviews`, and a cache that drifts is a number a
 *      shopper reads being wrong (memory `project_metric_integrity_audit`). Every path that can
 *      change it — a write, a moderation hide, an unhide — is followed by the same invariant.
 *   2. **One purchase earns one review**, enforced by the unique index rather than by a read, so
 *      that two simultaneous submits cannot both get through.
 *
 * Plus the endpoint's authorization, which is the part an attacker actually touches.
 */

const ctx = (body: unknown, cookieValue?: string): APIContext => ({
  request: new Request('http://localhost/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  cookies: {
    get: () => (cookieValue ? { value: cookieValue } : undefined),
    set: () => {}, delete: () => {}, has: () => false,
  } as unknown as AstroCookies,
  clientAddress: '127.0.0.1',
} as unknown as APIContext);

const KERAMIKA = '22222222-2222-4222-8222-000000000001';

async function productId(slug: string): Promise<string> {
  const row = await firstRow<{ id: string }>(
    'SELECT id FROM store_products WHERE store_id = $1 AND slug = $2', [KERAMIKA, slug]);
  return row!.id;
}

/** A paid order that has actually shipped — the only shape a review can start from. */
async function shippedOrder(slug = 'agartal') {
  const res = await checkout(ctx({
    buyerName: 'דנה כהן', buyerEmail: 'reviews@example.test', buyerPhone: '0501234567',
    buyerAddress: { city: 'תל אביב', street: 'הרצל 1' },
    items: [{ storeSlug: 'keramika', productSlug: slug, qty: 1, selectedVariants: { צבע: 'כחול' } }],
    idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
  }) as unknown as APIContext);
  const body = await res.json() as { orderIds?: string[] };
  const id = body.orderIds![0]!;
  await updateOrder(id, { shippingStatus: 'delivered' });
  return (await getOrderById(id))!;
}

/** The cache and the rows agree. Asserted after every write path, never assumed. */
async function expectCacheMatchesRows(id: string): Promise<void> {
  const truth = await firstRow<{ n: string; total: string | null }>(
    'SELECT count(*) AS n, sum(rating) AS total FROM product_reviews WHERE product_id = $1 AND NOT blocked',
    [id],
  );
  const cached = await getProductRating(id);
  expect(cached.count).toBe(Number(truth!.n));
  expect(cached.sum).toBe(Number(truth!.total ?? 0));
}

beforeEach(async () => {
  await query('DELETE FROM product_reviews');
  await query('DELETE FROM checkout_idempotency');
  await query('DELETE FROM order_items');
  await query('DELETE FROM order_stores');
  await query('DELETE FROM orders');
  await query('UPDATE store_products SET stock = 20, review_count = 0, review_rating_sum = 0 WHERE store_id = $1', [KERAMIKA]);
});

describe('the cached score is rebuilt from the reviews, never adjusted', () => {
  it('follows every write, hide and unhide', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    await expectCacheMatchesRows(pid);

    const review = await createReview({
      productId: pid, storeSlug: 'keramika', orderId: order.id,
      buyerFullName: 'דנה כהן', rating: 4, body: 'יפה מאוד',
    });
    expect(review).not.toBeNull();
    expect((await getProductRating(pid))).toEqual({ count: 1, sum: 4 });
    await expectCacheMatchesRows(pid);

    // Hiding must move the SCORE too — a moderated 1-star that leaves the average untouched is a
    // bug report waiting to be filed, and it would keep exporting text we decided not to publish.
    await setReviewBlocked(review!.id, true);
    expect(await getProductRating(pid)).toEqual({ count: 0, sum: 0 });
    await expectCacheMatchesRows(pid);
    expect(await getReviewsForProduct(pid)).toEqual([]);

    await setReviewBlocked(review!.id, false);
    expect(await getProductRating(pid)).toEqual({ count: 1, sum: 4 });
    await expectCacheMatchesRows(pid);
  });

  it('publishes the shortened name, never the checkout name', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const review = await createReview({
      productId: pid, storeSlug: 'keramika', orderId: order.id,
      buyerFullName: 'דנה כהן', rating: 5, body: '',
    });
    expect(review!.reviewerName).toBe('דנה כ׳');
    expect(review!.reviewerName).not.toContain('כהן');
  });
});

describe('one purchase, one review', () => {
  it('refuses the second by constraint, not by a read', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const input = {
      productId: pid, storeSlug: 'keramika', orderId: order.id,
      buyerFullName: 'דנה כהן', rating: 5, body: 'מצוין',
    };
    expect(await createReview(input)).not.toBeNull();
    // Null rather than a throw: it is what actually happened, and the page says so.
    expect(await createReview({ ...input, rating: 1 })).toBeNull();
    expect(await getProductRating(pid)).toEqual({ count: 1, sum: 5 });
    await expectCacheMatchesRows(pid);
  });

  it('survives two simultaneous submits — the race a read-first check would lose', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const input = {
      productId: pid, storeSlug: 'keramika', orderId: order.id,
      buyerFullName: 'דנה כהן', rating: 3, body: 'בסדר',
    };
    const [a, b] = await Promise.all([createReview(input), createReview(input)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await getProductRating(pid)).count).toBe(1);
  });

  it('stops offering the form once the purchase is spent', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const buyerId = order.buyerId ?? '';
    // Guest checkout here, so there is no buyer id to ask with — the guarantee that matters is
    // that a spent purchase is not offered again, which `getReviewedProductIds` answers.
    expect(await getReviewedProductIds(order.id)).toEqual([]);
    await createReview({
      productId: pid, storeSlug: 'keramika', orderId: order.id,
      buyerFullName: 'דנה', rating: 5, body: '',
    });
    expect(await getReviewedProductIds(order.id)).toEqual([pid]);
    if (buyerId) expect(await getReviewableOrderForProduct(buyerId, pid)).toBeNull();
  });
});

describe('/api/review refuses everything it should', () => {
  it('writes one when the caller holds the order', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const res = await postReview(ctx({
      orderId: order.id, productId: pid, rating: 5, body: 'מעולה', token: reviewToken(order.id),
    }) as never);
    expect(res.status).toBe(200);
    expect(await countPublishedReviews()).toBe(1);
    await expectCacheMatchesRows(pid);
  });

  it('refuses a valid order with no proof at all', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const res = await postReview(ctx({ orderId: order.id, productId: pid, rating: 5 }) as never);
    expect(res.status).toBe(403);
    expect(await countPublishedReviews()).toBe(0);
  });

  it('refuses another order\'s token', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const res = await postReview(ctx({
      orderId: order.id, productId: pid, rating: 5,
      token: reviewToken('00000000-0000-4000-8000-000000000999'),
    }) as never);
    expect(res.status).toBe(403);
  });

  it('refuses a product the order does not contain — an id is not a permission', async () => {
    const order = await shippedOrder('agartal');
    // A real product of the SAME store — the nearest miss, and the one a bare "does this exist"
    // check would have let through.
    const other = await productId('menora');
    const res = await postReview(ctx({
      orderId: order.id, productId: other, rating: 5, token: reviewToken(order.id),
    }) as never);
    expect(res.status).toBe(403);
    expect(await getProductRating(other)).toEqual({ count: 0, sum: 0 });
  });

  it('refuses an order that has not shipped, and one that was cancelled', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    for (const status of ['pending', 'cancelled'] as const) {
      await updateOrder(order.id, { shippingStatus: status });
      const res = await postReview(ctx({
        orderId: order.id, productId: pid, rating: 5, token: reviewToken(order.id),
      }) as never);
      expect(res.status, status).toBe(403);
    }
    expect(await countPublishedReviews()).toBe(0);
  });

  it('refuses a rating outside the scale rather than clamping it', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    for (const rating of [0, 6, 4.5, '5']) {
      const res = await postReview(ctx({
        orderId: order.id, productId: pid, rating, token: reviewToken(order.id),
      }) as never);
      expect(res.status, String(rating)).toBe(400);
    }
    expect(await countPublishedReviews()).toBe(0);
  });

  it('refuses an over-long body rather than publishing a truncated one', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const res = await postReview(ctx({
      orderId: order.id, productId: pid, rating: 5, body: 'א'.repeat(1600), token: reviewToken(order.id),
    }) as never);
    expect(res.status).toBe(400);
    expect(await countPublishedReviews()).toBe(0);
  });

  it('answers 409 for a purchase already reviewed', async () => {
    const order = await shippedOrder();
    const pid = await productId('agartal');
    const body = { orderId: order.id, productId: pid, rating: 5, token: reviewToken(order.id) };
    expect((await postReview(ctx(body) as never)).status).toBe(200);
    expect((await postReview(ctx(body) as never)).status).toBe(409);
    expect(await countPublishedReviews()).toBe(1);
  });
});
