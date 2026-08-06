-- A third reason the platform stops a boost by itself: nothing it advertises has a photo.
--
-- `image_link` is a REQUIRED Merchant Center / Meta Catalog attribute, so a product without a photo
-- is not in the catalogue at all — it sits on the storefront looking fine while no ad can carry it
-- (`product-feed.ts#isProductAdvertisable`). Until 2026-08-06 the campaign card counted such a
-- product as advertised, so a boost could read "פעיל" while advertising literally nothing. The count
-- was fixed first (`CampaignHealth.advertisable`) and reported without acting; the owner's decision
-- on 2026-08-06 was to act on it, which needs a reason of its own on the row.
--
-- **Why it could not reuse either existing value, which is the whole reason for this migration.**
-- The two stored reasons differ in WHO may undo them (`ad-campaign-health.ts`):
--   · 'unavailable'  — a human took the product off the shelf, so only a human restarts it.
--   · 'out-of-stock' — mechanical and temporary, so the same sweep restarts it by itself.
-- A missing photo behaves like the second: it clears the moment the seller uploads one, and making
-- him also find and press "resume" would be a penalty for fixing it. But labelling it 'out-of-stock'
-- would put "אזל מהמלאי" on a card about a photo — a false statement to the seller about his own
-- shop, in the one place he goes to find out why his ad stopped. Hence a third value rather than a
-- reuse of either.
--
-- Widening a CHECK is additive and zero-downtime-safe: no existing row changes, and the previous
-- deployment keeps working because it never writes this value and its own two stay legal. The
-- reverse (a deploy that writes 'no-image' against the old constraint) is what the ordering rule
-- exists for — this migration ships before the code that writes it.

ALTER TABLE ad_campaigns DROP CONSTRAINT IF EXISTS ad_campaigns_paused_reason_check;

ALTER TABLE ad_campaigns
  ADD CONSTRAINT ad_campaigns_paused_reason_check
  CHECK (paused_reason IN ('unavailable', 'out-of-stock', 'no-image'));
