import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { query, firstRow } from '../src/lib/db.js';
import {
  createDemoReview, getReviewsForProduct, getProductRating,
  countPublishedReviews, getReviewsForProductIds,
} from '../src/lib/product-reviews.js';

/**
 * An illustrative rating with no purchase behind it — the showcase stores' half of the feature.
 *
 * The showcase stores are the platform's shop window and are live on day one, so a blank review
 * section there teaches the first seller that the feature is empty. Giving them REAL reviews meant
 * writing fabricated ORDERS underneath, and those are counted as revenue by every money surface —
 * so the owner asked the question that dissolved the trade-off: why not a demo review that is only
 * a demo? Migration 0040 is the answer, and this file pins the three things that make it safe.
 */

const KERAMIKA = '22222222-2222-4222-8222-000000000001';

const productId = async (slug: string): Promise<string> => {
  const row = await firstRow<{ id: string }>(
    'SELECT id FROM store_products WHERE store_id = $1 AND slug = $2', [KERAMIKA, slug]);
  return row!.id;
};

beforeEach(async () => {
  await query('DELETE FROM product_reviews');
  await query('UPDATE store_products SET review_count = 0, review_rating_sum = 0');
});

describe('the constraint keeps the two kinds apart', () => {
  it('refuses a REAL review with no order — the guarantee that was there before', async () => {
    // This is the whole point of the change being safe: making `order_id` nullable did not loosen
    // "a review needs a purchase", it moved that rule into a CHECK where it is stated out loud.
    const pid = await productId('agartal');
    await expect(query(
      `INSERT INTO product_reviews (id, product_id, store_slug, reviewer_name, rating, body, demo)
       VALUES ($1, $2, 'keramika', 'א', 5, '', false)`,
      [crypto.randomUUID(), pid],
    )).rejects.toThrow(/product_reviews_demo_has_no_order/);
  });

  it('refuses a DEMO review that claims an order', async () => {
    const pid = await productId('agartal');
    const orderId = crypto.randomUUID();
    await query(
      `INSERT INTO orders (id, buyer_name, buyer_email, buyer_phone, buyer_city, buyer_street,
                           shipping_agorot, total_agorot, payment_status, shipping_status)
       VALUES ($1, 'ד', 'x@example.test', '0500000000', 'תל אביב', 'הרצל 1', 0, 100, 'paid', 'delivered')`,
      [orderId],
    );
    await expect(query(
      `INSERT INTO product_reviews (id, product_id, store_slug, order_id, reviewer_name, rating, body, demo)
       VALUES ($1, $2, 'keramika', $3, 'א', 5, '', true)`,
      [crypto.randomUUID(), pid, orderId],
    )).rejects.toThrow(/product_reviews_demo_has_no_order/);
    await query('DELETE FROM orders WHERE id = $1', [orderId]);
  });
});

describe('a demo review is a review on the page and nothing anywhere else', () => {
  it('shows on the product and moves its score', async () => {
    const pid = await productId('agartal');
    await createDemoReview({ productId: pid, storeSlug: 'keramika', buyerFullName: 'נועה לוי', rating: 4, body: 'יפה' });
    await createDemoReview({ productId: pid, storeSlug: 'keramika', buyerFullName: 'אורי כהן', rating: 5, body: '' });

    expect(await getReviewsForProduct(pid)).toHaveLength(2);
    expect(await getProductRating(pid)).toEqual({ count: 2, sum: 9 });
    // The published name rule is the same one real reviews get — nothing about a demo row is a
    // second code path.
    expect((await getReviewsForProduct(pid))[0]!.reviewerName).toMatch(/[א-ת]+ [א-ת]׳/);
  });

  it('does NOT count toward Google\'s 50-review threshold', async () => {
    // The number that tells the owner whether Merchant Center will accept the feed. Counting demo
    // rows would announce a milestone nobody had crossed and send him to connect a feed that gets
    // rejected (GO_LIVE §2.7).
    const pid = await productId('agartal');
    for (let i = 0; i < 5; i++) {
      await createDemoReview({ productId: pid, storeSlug: 'keramika', buyerFullName: 'דנה כהן', rating: 5, body: 'x' });
    }
    expect(await getProductRating(pid)).toEqual({ count: 5, sum: 25 });
    expect(await countPublishedReviews()).toBe(0);
  });

  it('is never handed to the Google reviews feed', async () => {
    // The second lock. `getIndexableStores` already keeps demo STORES out, so this covers the row
    // itself — submitting invented reviews is a policy violation against the one Merchant Center
    // account every seller shares, and that is not a risk to leave to a single predicate.
    const pid = await productId('agartal');
    await createDemoReview({ productId: pid, storeSlug: 'keramika', buyerFullName: 'תמר', rating: 5, body: 'מעולה' });
    expect((await getReviewsForProductIds([pid])).get(pid)).toBeUndefined();
  });

  it('leaves no order behind it, which is the whole reason it exists', async () => {
    const pid = await productId('agartal');
    const before = await firstRow<{ n: string }>('SELECT count(*) AS n FROM orders');
    await createDemoReview({ productId: pid, storeSlug: 'keramika', buyerFullName: 'ליאור', rating: 3, body: 'בסדר' });
    const after = await firstRow<{ n: string }>('SELECT count(*) AS n FROM orders');
    expect(after!.n).toBe(before!.n);
    expect((await getReviewsForProduct(pid))[0]!.orderId).toBeNull();
  });
});
