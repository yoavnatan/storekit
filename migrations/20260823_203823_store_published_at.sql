-- The moment a store went public — and, by its absence, the state that did not exist before:
-- a store the SELLER can see and the public cannot.
--
-- ── Why a column and not a flag someone sets ──
--
-- A seller registers, builds a whole shop and looks at it before he is asked for a card (owner,
-- 2026-08-23): "מי שלא ראה מה הוא מקבל לא ישלם". So between "the store row exists" and "strangers
-- can reach it" there is now a real interval, and TWO independent things can hold a store inside
-- it:
--
--   · PayMe examine every business before it may clear a card, and that takes up to seven business
--     days (agreement §11). Nothing about it is the seller's fault and nothing he does shortens it.
--   · A seller who has not started a subscription is not paying to be on the platform, so his shop
--     is not on it.
--
-- They are the same STATE — the seller sees his shop, the public does not — with two different
-- sentences to say about it. Modelling them as two flags would let them contradict each other
-- (published-because-approved while unpaid), so what is stored is the OUTCOME, once: the instant
-- the shop went live. `lib/store-publication.ts` owns the arithmetic that decides it, and
-- `lib/store-status.ts` holds what the state means for every surface — the same table the other
-- four lifecycle states already live in, because a fifth `if` in a page is how the other four
-- drifted apart in the first place.
--
-- ── Why it is backfilled and the other timestamps are not ──
--
-- `paused_at`/`closed_at` (0001) record something that HAPPENED, so inventing one would be a lie.
-- This one records the absence of a hold that did not exist until today: every store already on
-- the site is, by definition, already public. Leaving them NULL would take the entire catalogue
-- off the platform on the deploy that adds this column — including the showcase stores, which are
-- launch product. `created_at` is the honest value: that is when they became visible.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS published_at timestamptz;

UPDATE stores SET published_at = created_at WHERE published_at IS NULL;

COMMENT ON COLUMN stores.published_at IS
  'When the store first became public. NULL = built but not live: the seller can preview it, no
   platform surface lists it and its URL 404s for everyone else (lib/store-status.ts, state
   "unpublished"). Written only by lib/store-publication.ts, never cleared — un-publishing is what
   pause/close/block are for, and each of those keeps its own reason.';

-- The discovery surfaces ask "which stores are live", and after this change that is two predicates
-- rather than one. `stores_live_idx` (0001) is partial on `NOT blocked AND deleted_at IS NULL`; the
-- publication half is added here as its own partial index rather than by replacing that one, which
-- is an applied migration and cannot be edited.
CREATE INDEX IF NOT EXISTS stores_published_idx
  ON stores (created_at DESC, id)
  WHERE published_at IS NOT NULL AND NOT blocked AND deleted_at IS NULL;
