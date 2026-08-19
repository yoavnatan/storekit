import crypto from 'node:crypto';
import { rows, firstRow, query, withTransaction, type Queryable } from './db.js';
import { reviewerDisplayName, type RatingAggregate } from './reviews.js';
import { REVENUE_PAYMENT_STATUSES, REVIEWABLE_SHIPPING_STATUSES } from './order-status-rules.js';
import { BUSINESS_TIMEZONE } from './business-day.js';
import { reviewSearchTerms, type AdminReviewQuery } from './admin-reviews-filter.js';

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
  /** The purchase this review belongs to. `null` ONLY for a demo review, which has none — see
   *  migration 0040 for why that is a constraint and not a loosening. */
  orderId: string | null;
  buyerId: string | null;
  /** Already shortened for publication (`reviews.ts#reviewerDisplayName`), possibly empty. */
  reviewerName: string;
  rating: number;
  body: string;
  blocked: boolean;
  /** An illustrative rating on a showcase store, with no purchase behind it. Excluded from the
   *  Google feed and from the threshold count; see migration 0040. */
  demo: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  product_id: string;
  store_slug: string;
  order_id: string | null;
  buyer_id: string | null;
  reviewer_name: string;
  rating: number;
  body: string;
  blocked: boolean;
  demo: boolean;
  created_at: Date | string;
}

const COLUMNS = 'id, product_id, store_slug, order_id, buyer_id, reviewer_name, rating, body, blocked, demo, created_at';

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
    demo: r.demo,
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
/**
 * A showcase store's illustrative rating — no purchase, no order, no money.
 *
 * The only writer of `demo = true`, and it exists because the alternative was worse: giving the
 * showcase stores real reviews meant writing real ORDERS underneath them, and those are counted as
 * revenue by every money surface (migration 0040 tells the whole story). This writes a review and
 * nothing else.
 *
 * Not reachable from any request — `scripts/seed-reviews.mjs` is the only caller, and the API goes
 * through `createReview`, which cannot set the flag.
 */
export async function createDemoReview(input: Omit<NewReview, 'orderId' | 'buyerId'>): Promise<ProductReview | null> {
  return withTransaction(async (tx) => {
    const inserted = await tx.query<Row>(
      `INSERT INTO product_reviews (id, product_id, store_slug, order_id, buyer_id, reviewer_name, rating, body, demo)
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, true)
       RETURNING ${COLUMNS}`,
      [crypto.randomUUID(), input.productId, input.storeSlug,
       reviewerDisplayName(input.buyerFullName), input.rating, input.body],
    );
    const row = inserted.rows[0];
    if (!row) return null;
    await recomputeProductRating(input.productId, tx);
    return toReview(row);
  });
}

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

/**
 * The platform's reviews as the admin's Reviews tab reads them, blocked ones INCLUDED.
 *
 * Blocked rows are in it on purpose and it is the whole point of the screen: an admin who hid
 * something has to be able to see what they hid and put it back. The product and store names ride
 * along because a review with no product beside it is unactionable, and the alternative is one
 * lookup per row on a page that renders fifteen. `sellerId` rides along for the same reason the
 * toolbar can filter by it — one account can run several stores.
 */
export interface AdminReviewRow extends ProductReview {
  productName: string;
  productSlug: string;
  storeName: string;
  sellerId: string;
}

export interface AdminReviewsPage {
  reviews: AdminReviewRow[];
  /** Rows matching the narrowing, across all pages. */
  total: number;
}

/**
 * One page of reviews, narrowed, ordered, counted and sliced entirely in the query.
 *
 * **Why not the old `getRecentReviews`, which took the newest 25 and rendered them.** This table
 * grows with every delivered purchase on the platform, and a fixed head with no way to ask anything
 * meant the answer to "show me what this store's buyers wrote" was to page until it appeared — so
 * there was no such answer. Narrowing in SQL rather than in JS is the same decision the money
 * journal reached (`money-events.ts#getMoneyEventsPage`) and for the same three costs: the network
 * transfer, the allocation, and a (terms × rows) scan on a single-threaded SSR server.
 *
 * **`LEFT JOIN … ON true`, not `count(*) OVER ()`** — copied deliberately from the journal, where
 * it is a real bug rather than a style choice: a window function has no row to ride on when the
 * page is past the end of the result (a hand-typed `?vpage=999`), so the total would come back 0
 * and the pager would report an empty tab.
 *
 * **`r.demo` is in the SELECT, and its absence was a live bug.** `AdminReviewsPanel.astro` renders
 * the same "לדוגמה" mark the shopper sees, and argues on its own header why that matters precisely
 * here — this is the screen used to decide whether to take a review down, and 83 seeded ratings
 * that look exactly like buyers' own is the wrong basis for that decision. The column was never
 * selected, so `demo` arrived `undefined`, and the badge had never once rendered.
 * `tests/admin-reviews-query-db.test.ts` pins it.
 */
export async function getAdminReviewsPage(
  query: AdminReviewQuery,
  offset: number,
  limit: number,
): Promise<AdminReviewsPage> {
  const params: unknown[] = [];
  const where: string[] = [];

  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.store) where.push(`r.store_slug = ${bind(query.store)}`);
  if (query.seller) where.push(`s.seller_id::text = ${bind(query.seller)}`);
  if (query.state !== 'all') where.push(`r.blocked = ${bind(query.state === 'hidden')}`);
  // Bounds are the admin's local calendar, not UTC — the same rule every dated admin filter obeys
  // (`business-day.ts`). A review written at 01:00 Jerusalem belongs to the day he would name.
  if (query.from) {
    where.push(`r.created_at >= (${bind(query.from)}::date)::timestamp AT TIME ZONE ${bind(BUSINESS_TIMEZONE)}`);
  }
  if (query.to) {
    where.push(`r.created_at < (${bind(query.to)}::date + 1)::timestamp AT TIME ZONE ${bind(BUSINESS_TIMEZONE)}`);
  }
  // Terms are ANDed, each matching the review's text, its author's name or the product's — the
  // three things somebody arriving at this tab actually remembers. Bounded by the parser.
  for (const term of reviewSearchTerms(query.q)) {
    const like = bind(`%${term}%`);
    where.push(`(r.body ILIKE ${like} OR r.reviewer_name ILIKE ${like} OR p.name ILIKE ${like})`);
  }

  const clause = where.length ? where.join(' AND ') : 'true';
  const from = `FROM product_reviews r
       JOIN store_products p ON p.id = r.product_id
       JOIN stores s ON s.id = p.store_id
      WHERE ${clause}`;
  const limitParam = bind(limit);
  const offsetParam = bind(offset);

  const found = await rows<Partial<Row> & {
    total_count: string | number;
    product_name?: string;
    product_slug?: string;
    store_name?: string;
    seller_id?: string;
  }>(
    `WITH n AS (SELECT count(*) AS total_count ${from}),
          pg AS (SELECT r.id, r.product_id, r.store_slug, r.order_id, r.buyer_id, r.reviewer_name,
                        r.rating, r.body, r.blocked, r.demo, r.created_at,
                        p.name AS product_name, p.slug AS product_slug,
                        s.name AS store_name, s.seller_id::text AS seller_id
                   ${from}
                  ORDER BY r.created_at DESC, r.id
                  LIMIT ${limitParam} OFFSET ${offsetParam})
     SELECT n.total_count, pg.* FROM n LEFT JOIN pg ON true`,
    params,
  );

  return {
    // A page past the end still returns the count row, with every review column NULL.
    reviews: found.filter((row) => row.id).map((row) => ({
      ...toReview(row as Row),
      productName: row.product_name ?? '',
      productSlug: row.product_slug ?? '',
      storeName: row.store_name ?? '',
      sellerId: row.seller_id ?? '',
    })),
    // `count` is a bigint: a string from `pg`, a number from PGlite (§8).
    total: Number(found[0]?.total_count ?? 0),
  };
}

/**
 * Every review on the platform, hidden ones included — the denominator the Reviews tab prints.
 *
 * Distinct from `countPublishedReviews` next door, which excludes blocked and demo rows because it
 * answers a PUBLIC question. This one answers an administrative one: "3 מתוך 412" only means
 * something if 412 is everything there is, and a tab that quietly excluded what an admin had hidden
 * would misreport itself to the one person who can act on it.
 */
export async function countAllReviews(): Promise<number> {
  const row = await firstRow<{ n: string | number }>('SELECT count(*) AS n FROM product_reviews');
  return Number(row?.n ?? 0);
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

/**
 * How many REAL published reviews the whole platform holds.
 *
 * Google's Product Ratings programme needs 50 across the account before it will take the feed at
 * all (GO_LIVE §2.7), so this is the number that says whether that milestone has been reached —
 * which is exactly why `NOT demo` is in the predicate. The showcase stores carry illustrative
 * ratings that are never submitted; counting them would announce a threshold nobody had crossed and
 * send the owner to Merchant Center to connect a feed that would be rejected.
 */
export async function countPublishedReviews(): Promise<number> {
  const row = await firstRow<{ n: string }>(
    'SELECT count(*) AS n FROM product_reviews WHERE NOT blocked AND NOT demo');
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
    // `NOT demo` is the SECOND lock, and it is deliberate belt-and-braces: the caller already walks
    // `getIndexableStores`, which excludes demo stores, so an illustrative review cannot reach the
    // feed through the store it sits on. This makes it impossible through the review itself too —
    // submitting invented reviews is a policy violation against the one Merchant Center account
    // every seller on the platform shares, and that is not a risk to leave to one predicate.
    `SELECT ${COLUMNS} FROM product_reviews
      WHERE product_id = ANY($1::uuid[]) AND NOT blocked AND NOT demo
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
