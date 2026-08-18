-- Remove the fabricated orders the FIRST version of the showcase-review seeder wrote.
--
-- For one day, `product_reviews.order_id` was NOT NULL, so giving the showcase stores ratings meant
-- writing an order under each one. Migration 0040 removed the need; this removes the residue.
--
-- **It has to be a migration and not a line in the seeder**, because those rows are MONEY. They are
-- `payment_status = 'paid'` orders on showcase stores, so the accountant's report, the
-- reconciliation card and the platform's own balance all count them as revenue — and the new purge
-- (`purgeDemoReviews`) matches on the `demo` flag, which these rows do not have. Nothing else would
-- ever have found them again. Any environment that ran the seeder in that window carries the same
-- ~90 invented sales until this runs.
--
-- The predicate is the buyer address the seeder stamped on every row it wrote, `%@reviews.demo` —
-- a reserved-looking domain nobody can register and no real checkout can produce. Deliberately NOT
-- "orders on demo stores": a showcase store cannot be checked out (`lib/demo-stores.ts`), so an
-- order on one is fabricated by definition — but if some other route ever put a real record there,
-- deleting it because of its STORE would be destroying financial history to tidy up a demo.
--
-- Children first: `order_items` and `order_stores` reference `orders` with ON DELETE RESTRICT, and
-- the reviews themselves point at the orders, so they lead.

DELETE FROM product_reviews
 WHERE order_id IN (SELECT id FROM orders WHERE buyer_email LIKE '%@reviews.demo');

DELETE FROM order_items
 WHERE order_id IN (SELECT id FROM orders WHERE buyer_email LIKE '%@reviews.demo');

DELETE FROM order_stores
 WHERE order_id IN (SELECT id FROM orders WHERE buyer_email LIKE '%@reviews.demo');

DELETE FROM orders WHERE buyer_email LIKE '%@reviews.demo';

-- The cached score on every product those reviews belonged to. Recomputed from the table rather
-- than decremented, exactly as `product-reviews.ts#recomputeProductRating` does it — a delta here
-- would be a second definition of the aggregate, in SQL, where nothing tests it.
UPDATE store_products p
   SET review_count = agg.n, review_rating_sum = agg.total
  FROM (SELECT sp.id,
               count(r.id)::int AS n,
               COALESCE(sum(r.rating), 0)::int AS total
          FROM store_products sp
          LEFT JOIN product_reviews r ON r.product_id = sp.id AND NOT r.blocked
         GROUP BY sp.id) agg
 WHERE p.id = agg.id AND (p.review_count <> agg.n OR p.review_rating_sum <> agg.total);
