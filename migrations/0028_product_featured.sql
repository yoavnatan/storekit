-- Seller-chosen products for the homepage store card.
--
-- Until now `getStorePreviews` drew the four NEWEST visible products with a photo and nothing
-- could change that — not the seller, not the owner. A seller with one flagship product showed
-- whatever they happened to upload last, and the store card is the only picture of a shop a
-- stranger meets on the homepage.
--
-- ADDITIVE and defaulted, per the zero-downtime rule in AI_INSTRUCTIONS: the deployed version
-- keeps working against this column because every existing row reads `false`, which is exactly
-- "no choice made" — and the preview query treats that as "fall back to newest", so a store that
-- never touches the feature looks precisely as it does today. That matters beyond deploys: a brand
-- new store must look full from its first upload, before its owner has discovered any of this.
--
-- 0028 and not 0026: two other sessions had already applied 0026 and 0027 to the shared dev
-- database on 2026-08-14 without merging them (memory `feedback_parallel_sessions` — a worktree
-- cannot isolate a migration NUMBER).
ALTER TABLE store_products
  ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

-- PARTIAL, on the true rows only. The preview query orders by `featured DESC, created_at DESC` per
-- store, and the flagged rows are at most a handful per store against a table that holds every
-- product on the platform — so an index over all of them would be almost entirely `false` entries
-- that no query ever seeks. `WHERE featured` keeps it to the rows that are actually asked for.
CREATE INDEX IF NOT EXISTS idx_store_products_featured
  ON store_products (store_id) WHERE featured;
