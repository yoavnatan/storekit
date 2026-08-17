-- Product reviews — a rating (1-5) and optional text, written by someone who actually bought it.
--
-- ── Why a review is anchored to an ORDER LINE and not to a person ──
-- `UNIQUE (order_id, product_id)` is the whole eligibility model expressed as a constraint. One
-- purchase of one product earns one review, whoever wrote it and however they signed in. Anchoring
-- to a buyer instead would have two holes at once: a guest checkout has no buyer id at all (the
-- common case — `orders.buyer_id` is NULL for it), and a buyer who bought the same product twice
-- genuinely has two experiences of it. The order line is the thing that is real in both directions.
--
-- It also makes the abuse case a database error rather than an application check: there is no
-- sequence of requests that writes two reviews for one purchase, including two that race.
--
-- ── Why `product_id` cascades and `order_id` restricts ──
-- Deleting a product should take its reviews with it: a review of something nobody can buy is
-- unreachable text that would still be published to Google in the review feed. Deleting an ORDER
-- must never be possible while a review points at it — the order IS the proof of purchase, and
-- `RESTRICT` matches every other child of `orders` in this schema (order_items, order_stores,
-- return_requests) for the same reason: financial history does not get deleted.
--
-- ── Why the aggregate is cached on `store_products` ──
-- The stars belong on every product CARD — the homepage spotlight, the store grid, search results,
-- the related strip. As a join those are per-card aggregate scans on the platform's hottest
-- queries. The two columns below are recomputed FROM this table by a single statement after every
-- write (`product-reviews.ts#recomputeProductRating`), never incremented by a delta: a recompute
-- cannot drift, a `+= 1` can, and drift in a number a shopper reads is the class this project has
-- already paid for once (memory `project_metric_integrity_audit`).

CREATE TABLE IF NOT EXISTS product_reviews (
  id           uuid PRIMARY KEY,
  product_id   uuid NOT NULL REFERENCES store_products(id) ON DELETE CASCADE,
  -- Denormalised, exactly as `return_requests.store_slug` is and for the same reason: the seller's
  -- own list and the admin queue answer "whose reviews are these" without joining through orders.
  store_slug   text NOT NULL,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- NULL for a guest checkout — who reviewed is the ORDER, not the account. Kept when there is one
  -- so a signed-in buyer's own reviews can be listed back to them.
  buyer_id     uuid REFERENCES sellers(id) ON DELETE SET NULL,

  -- What is PUBLISHED beside the stars. Never the buyer's full name and never their email: derived
  -- once at write time by `reviews.ts#reviewerDisplayName` and stored, so a later change to that
  -- rule cannot silently rewrite what a person agreed to publish.
  reviewer_name text NOT NULL,

  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         text NOT NULL DEFAULT '',

  -- Admin kill switch, the same shape and the same word as `store_products.blocked`: the row stays
  -- (it is the buyer's, and the UNIQUE above still has to hold) and stops being published anywhere
  -- — page, aggregate, JSON-LD, Google feed.
  blocked      boolean NOT NULL DEFAULT false,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_reviews_one_per_line UNIQUE (order_id, product_id)
);

-- The product page's own list: newest first, published only. Partial on the same predicate the
-- aggregate is computed over, so the index answers both without a sort.
CREATE INDEX IF NOT EXISTS product_reviews_product_idx
  ON product_reviews (product_id, created_at DESC) WHERE NOT blocked;

-- The seller's list and the admin queue.
CREATE INDEX IF NOT EXISTS product_reviews_store_idx ON product_reviews (store_slug, created_at DESC);

-- "What have I already reviewed from this order" — read once per review page and per product page.
CREATE INDEX IF NOT EXISTS product_reviews_order_idx ON product_reviews (order_id);

-- ── The cached aggregate ──
-- Sum rather than average: an average stored as a float and re-averaged is a rounding argument
-- waiting to happen, and the sum is what the Product JSON-LD's `ratingValue` and the star fill are
-- both derived from (`reviews.ts#averageRating`), so there is one arithmetic and one place to read.
ALTER TABLE store_products
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0);
ALTER TABLE store_products
  ADD COLUMN IF NOT EXISTS review_rating_sum integer NOT NULL DEFAULT 0 CHECK (review_rating_sum >= 0);

COMMENT ON COLUMN store_products.review_count IS
  'Published reviews. Recomputed from product_reviews, never incremented — product-reviews.ts#recomputeProductRating.';
COMMENT ON COLUMN store_products.review_rating_sum IS
  'Sum of published ratings. average = sum / count (reviews.ts#averageRating).';
