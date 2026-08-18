-- A review that exists to be LOOKED AT — the showcase stores' ratings, with no purchase behind them.
--
-- ── Why this column and not fabricated orders (owner, 2026-08-18) ──
-- The showcase stores are the platform's own shop window and are LIVE on day one (GO_LIVE §6.2), so
-- they need ratings for the same reason they need products and photographs: a storefront with a
-- blank review section teaches the first seller that the feature is empty.
--
-- The first attempt gave them real reviews by writing real ORDERS underneath, because
-- `order_id` was NOT NULL and that was the whole guarantee. It worked and it was the wrong trade:
-- those orders are money. They land in the accountant's report, in the reconciliation card and in
-- the platform's own balance, none of which filter demo stores — so the choice became "no ratings
-- in the window" or "invented revenue in the books", and the owner rejected the framing rather than
-- the options. He was right: a demo review does not need a demo PURCHASE, it needs permission to
-- exist without one.
--
-- ── The guarantee is unchanged, and now it is written down ──
-- Before this, "a review needs a purchase" was enforced by `order_id NOT NULL` — true, and silent
-- about why. The CHECK below says it out loud and splits the two kinds so neither can drift into
-- the other:
--
--   a REAL review    → `demo = false` and an order it belongs to. Exactly as before.
--   a DEMO review    → `demo = true` and NO order, because there is no purchase to point at.
--
-- Nothing can be half of each: a real review with no order is refused by the constraint, and so is
-- a demo review pretending to have bought something.
--
-- ── What must never treat the two alike ──
-- Three places, and each is a different kind of wrong if it gets this backwards:
--
--   · the Google reviews feed — submitting invented reviews is a policy violation against the ONE
--     Merchant Center account every seller shares. Demo STORES were already excluded, so this is
--     the second lock rather than the first;
--   · `countPublishedReviews`, which answers "have we reached Google's 50-review threshold" —
--     counting demo rows would announce a milestone that had not happened;
--   · anything that becomes a claim to a shopper about a REAL shop. The showcase stores disclose
--     themselves on every product (`ProductDemoBadge`), which is what makes an illustrative rating
--     honest there and nowhere else.

ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;

-- `order_id` becomes nullable, and ONLY for the demo half — the CHECK below is what stops that from
-- being a loosening. Every existing row is real and keeps its order; the column's own FK, its
-- ON DELETE RESTRICT and the UNIQUE (order_id, product_id) that makes one purchase earn one review
-- are all untouched.
ALTER TABLE product_reviews ALTER COLUMN order_id DROP NOT NULL;

ALTER TABLE product_reviews DROP CONSTRAINT IF EXISTS product_reviews_demo_has_no_order;
ALTER TABLE product_reviews ADD CONSTRAINT product_reviews_demo_has_no_order
  CHECK ((demo AND order_id IS NULL) OR (NOT demo AND order_id IS NOT NULL));

COMMENT ON COLUMN product_reviews.demo IS
  'Illustrative rating on a showcase store — no purchase behind it. Never counted toward Google''s
   review threshold and never submitted to the reviews feed. See this migration for the full rule.';

-- The feed and the threshold both ask for "published, real" reviews. Partial on both predicates so
-- the index holds only the rows they can return.
CREATE INDEX IF NOT EXISTS product_reviews_real_idx
  ON product_reviews (created_at)
  WHERE NOT blocked AND NOT demo;
