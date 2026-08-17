import crypto from 'node:crypto';
import { rows, firstRow, query, withTransaction, type Queryable } from './db.js';
import { reviewerDisplayName, type RatingAggregate } from './reviews.js';
import { REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES } from './order-status-rules.js';

/**
 * Product reviews, stored.
 *
 * The rules a review obeys are next door and deliberately not here: the arithmetic in `reviews.ts`
 * (average, half stars, the published name), who is allowed to write one in
 * `review-eligibility.ts`. This file's whole job is rows.
 *
 * ── The one thing worth reading before touching anything ──
 * `store_products.review_count` / `review_rating_sum` are a CACHE of this table, and they are
 * rebuilt by `recomputeProductRating` — a `SELECT count(*), sum(rating)` written back — never by
 * `+= 1`. Every write path below calls it inside the same transaction as its own statement, so the
 * cache cannot be left one review behind by a failure between the two. A delta update would be
 * faster and would eventually be wrong, which for a number printed on a product card is the worse
 * of the two (memory `project_metric_integrity_audit`).
 */

export interface ProductReview {
  id: string;
  productId: string;
  storeSlug: string;
  orderId: string;
  buyerId: string | null;
  /** Already shortened for publication (`reviews.ts#reviewerDisplayName`), possibly empty. */
  reviewerName: string;
  rating: number;
  body: string;
  blocked: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  product_id: string;
  store_slug: string;
  order_id: string;
  buyer_id: string | null;
  reviewer_name: string;
  rating: number;
  body: string;
  blocked: boolean;
  created_at: Date | string;
}

const COLUMNS = 'id, product_id, store_slug, order_id, buyer_id, reviewer_name, rating, body, blocked, created_at';

function toReview(r: Row): ProductReview {
  return {
    id: r.id,
    productId: r.product_id,
    storeSlug: r.store_slug,
    orderId: r.order_id,
    buyerId: r.buyer_id,
    reviewerName: r.reviewer_name,
    rating: Number(r.rating),
    body: r.body,
    blocked: r.blocked,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/**
 * Rebuild one product's cached aggregate from the reviews themselves.
 *
 * Idempotent by construction — it derives the answer rather than adjusting it, so calling it twice,
 * or after a partly-failed write, or from a repair script, all land on the same two numbers.
 * `NOT blocked` here is the same predicate `product_reviews_product_idx` is partial on and the same
 * one the page lists by: a moderated review disappears from the score and the list together, which
 * is the only way those two can never contradict each other on screen.
 */
export async function recomputeProductRating(productId: string, tx?: Queryable): Promise<void> {
  const sql = `UPDATE store_products p
                  SET review_count = agg.n, review_rating_sum = agg.total
                 FROM (SELECT count(*)::int AS n, COALESCE(sum(rating), 0)::int AS total
                         FROM product_reviews
                        WHERE product_id = $1 AND NOT blocked) agg
                WHERE p.id = $1`;
  if (tx) await tx.query(sql, [productId]);
  else await query(sql, [productId]);
}

export interface NewReview {
  productId: string;
  storeSlug: string;
  orderId: string;
  buyerId?: string | null;
  /** The buyer's name as the ORDER holds it — shortened here, once, on the way in. */
  buyerFullName: string;
  rating: number;
  body: string;
}

/**
 * Write a review and refresh the product's score, or answer `null` because this purchase already
 * has one.
 *
 * **`ON CONFLICT DO NOTHING` and not a prior `SELECT`.** "Has this order reviewed this product" is
 * a question whose answer can change between asking and writing, and two taps on a slow phone are
 * enough to ask it twice. The unique index is the only check that cannot be raced, so it is the
 * one that decides; the read-first version would have let a double submit publish two reviews of
 * one purchase.
 *
 * A duplicate is not an error to the caller: the API turns it into "you have already reviewed
 * this", which is what actually happened.
 */
export async function createReview(input: NewReview): Promise<ProductReview | null> {
  return withTransaction(async (tx) => {
    const inserted = await tx.query<Row>(
      `INSERT INTO product_reviews (id, product_id, store_slug, order_id, buyer_id, reviewer_name, rating, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id, product_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        crypto.randomUUID(),
        input.productId,
        input.storeSlug,
        input.orderId,
        input.buyerId ?? null,
        reviewerDisplayName(input.buyerFullName),
        input.rating,
        input.body,
      ],
    );
    const row = inserted.rows[0];
    if (!row) return null;
    await recomputeProductRating(input.productId, tx);
    return toReview(row);
  });
}

/** The published reviews of one product, newest first — what the product page lists. */
export async function getReviewsForProduct(productId: string, limit = 20, offset = 0): Promise<ProductReview[]> {
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM product_reviews
      WHERE product_id = $1 AND NOT blocked
      ORDER BY created_at DESC, id
      LIMIT $2 OFFSET $3`,
    [productId, limit, offset],
  );
  return found.map(toReview);
}

/**
 * The distribution bar's five numbers — counted in SQL, not by reading the reviews.
 *
 * The first version selected every rating and tallied them in JS, which is five numbers bought at
 * the cost of one row per review, on a page every shopper loads. That is invisible at ten reviews
 * and is the shape this project has already paid for twice (`DB_MIGRATION_PLAN.md` §8): fine as a
 * file read, a growing scan the moment it is a query. `GROUP BY` returns at most five rows whatever
 * the product's history, and `ratingHistogram` fills in the scores nobody gave — a bar chart that
 * dropped its empty rows would re-scale itself on every new review.
 */
export async function getRatingCountsForProduct(productId: string): Promise<{ rating: number; count: number }[]> {
  const found = await rows<{ rating: number; n: string }>(
    `SELECT rating, count(*) AS n FROM product_reviews
      WHERE product_id = $1 AND NOT blocked
      GROUP BY rating`,
    [productId],
  );
  return found.map((r) => ({ rating: Number(r.rating), count: Number(r.n) }));
}

/** Which products of an order already carry a review — what the review page grays out and what
 *  the product page reads before offering the form. Includes blocked ones on purpose: the buyer
 *  used up their one review of that purchase whether or not it survived moderation, and offering
 *  the form again would only produce a duplicate-key refusal they cannot act on. */
export async function getReviewedProductIds(orderId: string): Promise<string[]> {
  const found = await rows<{ product_id: string }>(
    'SELECT product_id FROM product_reviews WHERE order_id = $1',
    [orderId],
  );
  return found.map((r) => r.product_id);
}

/** The seller's own list, and the admin's queue for one store. Blocked rows INCLUDED — an admin
 *  looking at moderation has to see what they hid. */
export async function getReviewsForStore(storeSlug: string, limit = 50): Promise<ProductReview[]> {
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM product_reviews WHERE store_slug = $1 ORDER BY created_at DESC, id LIMIT $2`,
    [storeSlug, limit],
  );
  return found.map(toReview);
}

/**
 * The platform's most recent reviews, blocked ones INCLUDED — the admin's takedown list.
 *
 * Blocked rows are in it on purpose and it is the whole point of the screen: an admin who hid
 * something has to be able to see what they hid and put it back. The product and store names ride
 * along because a review with no product beside it is unactionable, and the alternative is one
 * lookup per row on a page that renders twenty-five.
 */
export interface AdminReviewRow extends ProductReview {
  productName: string;
  productSlug: string;
  storeName: string;
}

export async function getRecentReviews(limit = 25): Promise<AdminReviewRow[]> {
  const found = await rows<Row & { product_name: string; product_slug: string; store_name: string }>(
    `SELECT r.id, r.product_id, r.store_slug, r.order_id, r.buyer_id, r.reviewer_name, r.rating,
            r.body, r.blocked, r.created_at,
            p.name AS product_name, p.slug AS product_slug, s.name AS store_name
       FROM product_reviews r
       JOIN store_products p ON p.id = r.product_id
       JOIN stores s ON s.id = p.store_id
      ORDER BY r.created_at DESC, r.id
      LIMIT $1`,
    [limit],
  );
  return found.map((row) => ({
    ...toReview(row),
    productName: row.product_name,
    productSlug: row.product_slug,
    storeName: row.store_name,
  }));
}

export async function getReviewById(id: string): Promise<ProductReview | null> {
  const row = await firstRow<Row>(`SELECT ${COLUMNS} FROM product_reviews WHERE id = $1`, [id]);
  return row ? toReview(row) : null;
}

/**
 * Admin moderation: hide a review, or put it back.
 *
 * The score is recomputed in the same transaction — hiding a 1-star review that leaves the average
 * untouched is a bug report waiting to be filed, and it would also leave the Google feed exporting
 * text the platform has decided not to publish.
 */
export async function setReviewBlocked(id: string, blocked: boolean): Promise<ProductReview | null> {
  return withTransaction(async (tx) => {
    const updated = await tx.query<Row>(
      `UPDATE product_reviews SET blocked = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, blocked],
    );
    const row = updated.rows[0];
    if (!row) return null;
    await recomputeProductRating(row.product_id, tx);
    return toReview(row);
  });
}

/** The aggregate as the pure helpers want it. Read from the CACHE columns — every caller on a hot
 *  path already has the product row in hand, so this exists for the few that do not. */
export async function getProductRating(productId: string): Promise<RatingAggregate> {
  const row = await firstRow<{ review_count: number; review_rating_sum: number }>(
    'SELECT review_count, review_rating_sum FROM store_products WHERE id = $1',
    [productId],
  );
  return { count: Number(row?.review_count ?? 0), sum: Number(row?.review_rating_sum ?? 0) };
}

/**
 * The signed-in buyer's own order that entitles them to review THIS product, or null.
 *
 * What the product page asks before it offers the form. Newest first, so a buyer who has bought the
 * same thing twice reviews the purchase they are most likely thinking about.
 *
 * **In SQL, not in JS.** The obvious version — read every order of this buyer and filter — runs on
 * a page every shopper loads and grows with the buyer's history; this is one indexed lookup that
 * returns at most one row. The status lists come from `order-status-rules.ts`, so the two halves of
 * the eligibility rule (here and `review-eligibility.ts`) are one table read two ways rather than
 * two rules.
 *
 * The `NOT EXISTS` is what keeps the form from being offered for a purchase already reviewed —
 * which would otherwise be a duplicate-key refusal the buyer can do nothing about.
 */
export async function getReviewableOrderForProduct(buyerId: string, productId: string): Promise<string | null> {
  const row = await firstRow<{ id: string }>(
    `SELECT o.id
       FROM orders o
       JOIN order_items i ON i.order_id = o.id
      WHERE o.buyer_id = $1
        AND i.product_id = $2
        AND o.payment_status = ANY($3)
        AND o.shipping_status = ANY($4)
        AND NOT EXISTS (SELECT 1 FROM product_reviews r WHERE r.order_id = o.id AND r.product_id = $2)
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [buyerId, productId, REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES],
  );
  return row?.id ?? null;
}

/** How many published reviews the whole platform holds — Google's Product Ratings programme needs
 *  50 before it will take the feed at all (GO_LIVE §2.7), so this is the number that decides
 *  whether that milestone has been reached, and the admin dashboard shows it. */
export async function countPublishedReviews(): Promise<number> {
  const row = await firstRow<{ n: string }>('SELECT count(*) AS n FROM product_reviews WHERE NOT blocked');
  return Number(row?.n ?? 0);
}

/**
 * The published reviews of many products at once, grouped by product id.
 *
 * One query per BATCH OF PRODUCTS, which is what the reviews feed walks — the alternative shape
 * (one query per product) is the per-store loop `DB_MIGRATION_PLAN.md` §8 spent a session removing
 * from the product feed, and it would arrive back here with the same symptom at the same scale.
 *
 * Note what this deliberately does NOT do: it does not decide which stores or products may be
 * published. That is `getIndexableStores` + `getVisibleProductsByStoreIds`, exactly as for the
 * product feed, and `review-feed-document.ts` composes the two. A visibility rule spelled a second
 * time in SQL here is the duplication `tests/store-lifecycle-guard.test.ts` exists to refuse.
 */
export async function getReviewsForProductIds(productIds: readonly string[]): Promise<Map<string, ProductReview[]>> {
  const byProduct = new Map<string, ProductReview[]>();
  if (!productIds.length) return byProduct;
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM product_reviews
      WHERE product_id = ANY($1::uuid[]) AND NOT blocked
      ORDER BY created_at, id`,
    [[...productIds]],
  );
  for (const row of found) {
    const review = toReview(row);
    const bucket = byProduct.get(review.productId);
    if (bucket) bucket.push(review);
    else byProduct.set(review.productId, [review]);
  }
  return byProduct;
}
