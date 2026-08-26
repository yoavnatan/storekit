-- A merchant the processor has REFUSED, told apart from one they have not got to yet.
--
-- ── The gap (owner, סשן א׳ §20, 2026-08-26) ──
-- *"מה קורה אם יש סירוב מחברת הסליקה לעסק? תסביר לי. מה היוזר רואה? הטוסטים הקטנים האלו לא
-- מספיקים. זה נרשם לי גם באדמין איפשהו?"*
--
-- The honest answer was: nothing happens. `seller_merchant_accounts.approved` is one boolean, so a
-- refusal and a review that has not finished are the same row — and the screen for both says "up to
-- seven business days". A refused seller therefore waited for ever, in a state that told him to keep
-- waiting, and nothing anywhere told us. Agreement §11 is explicit that PayMe may refuse a business
-- at their sole discretion, so this is not a rare path; it is one of the two outcomes of the step
-- every seller goes through.
--
-- ── Why `active` and not `rejected` ──
-- It is the field PayMe themselves answer with. `get-sellers` returns `seller_approved` and
-- `seller_active` as two separate flags (`payment-payme.ts#getSellerStatus`), and the pair is what
-- carries the distinction: not-approved-yet is `approved:false, active:true`, while a refusal or a
-- suspension is `active:false`. Storing their own vocabulary means a state nobody has met yet is
-- visible as itself rather than as our guess about it — the same reason `seller_subscriptions.status`
-- keeps their integer.
--
-- DEFAULT true, because that is what an account we opened and have not heard about is: live and
-- pending. Existing rows are exactly that, so the backfill is the default and there is nothing to
-- migrate.
--
-- Additive: old code that never selects this column keeps working through a deploy.

ALTER TABLE seller_merchant_accounts ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN seller_merchant_accounts.active IS
  'PayMe''s own seller_active. FALSE means they refused or suspended the business — a different
   state from approved=false, which only means the review has not finished. Read by
   clearingStatusFor (the seller''s screen) and merchantBlockFor (the checkout gate).';
