-- What the ADMIN actually decided, when he decided a dispute.
--
-- Two gaps the owner named on 2026-08-17, both about the same screen and both only visible once the
-- three doors into `disputed` existed:
--
--   · `admin_award_agorot` — the decision was all-or-nothing. Either the buyer got every shekel back
--     or he got none. The case that most needs a middle is exactly the one that reaches a person: a
--     product that came back USED is neither "as sold" nor "never returned", and forcing that into one
--     of two buttons means one side is always wrongly served. NULL = the whole refund, which is what
--     every decision made before this column existed was.
--
--   · The reason. `admin_note` already existed as a column and the screen never sent it, so a decision
--     that moved real money left no record of WHY. A month later, when a seller argues he was treated
--     unfairly, the status alone is not an answer. The API now refuses the decision without it — a
--     column that is optional in practice is one that is empty exactly when it matters.
--
-- Deliberately NOT `partial_offer_agorot`: that column is the SELLER's offer to the buyer, it is shown
-- to the buyer as an offer he may decline, and overloading it would make "who proposed this amount"
-- unanswerable — which is the one question a disputed case is about.
ALTER TABLE return_requests
  ADD COLUMN IF NOT EXISTS admin_award_agorot integer;

COMMENT ON COLUMN return_requests.admin_award_agorot IS
  'What the admin awarded the buyer when deciding a dispute. NULL = the full refund.';

-- Never negative, and never more than a refund could have been. The API caps it too; this is the half
-- that survives a future caller that forgets to.
ALTER TABLE return_requests
  DROP CONSTRAINT IF EXISTS return_requests_admin_award_nonneg;
ALTER TABLE return_requests
  ADD CONSTRAINT return_requests_admin_award_nonneg
  CHECK (admin_award_agorot IS NULL OR admin_award_agorot >= 0);
