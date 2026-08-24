-- A card held from the moment the seller decides, charged only when his shop goes up.
--
-- ── The gap this closes (owner, 2026-08-24) ──
-- *"אם מוכר ממתין לאישור מפיימי והוא עוד לא בחר מסלול או שילם, אז יכול להיות שעד שהוא כבר יקבל את
-- האישור בדרך הוא מצא כבר חלופה אחרת ולא ימשיך איתנו."*
--
-- Earlier the same day the paying step was moved to LAST, so that nobody is charged through PayMe's
-- seven-day review for a shop that is not on the site. That was right about the charge and wrong
-- about the commitment: it left the longest wait in the flow as the one stretch where the seller has
-- decided nothing, paid nothing and owes nothing — a week in which the only thing keeping him is
-- that he has not yet found somebody else.
--
-- The answer is not to charge him earlier. It is to take the DECISION earlier and the money later:
-- he picks a plan and puts a card on file while PayMe are reviewing, and the first charge fires when
-- the shop actually goes live. `docs/payme-sandbox-notes.md` §24 recorded the same conclusion when
-- our own merchant was re-opened for exactly this — Hosted Fields need `PAYME_OWN_PUBLIC_KEY`, which
-- is now stored.
--
-- ── `status` becomes nullable, and NULL is the new state ──
-- The column holds PayMe's own integer and is interpreted in exactly one place
-- (`payment-payme.ts#PAYME_SUB_STATUS`). A row that is armed with a card has no PayMe subscription
-- behind it at all — `provider_ref` is NULL for the same reason — so there is no integer of theirs
-- that could honestly go here. **NULL means PayMe have nothing; we hold a card.** A sentinel of our
-- own (0, -1) was the alternative and it is the worse one: it would put a number we invented into a
-- column documented as theirs, in the one place their page already publishes a wrong list.
ALTER TABLE seller_subscriptions ALTER COLUMN status DROP NOT NULL;

COMMENT ON COLUMN seller_subscriptions.status IS
  'PayMe''s own sub_status integer, stored unmapped — 1 initial · 2 active · 4 failed · 5 canceled ·
   6 completed · 7 retrying. NULL = there is no subscription at PayMe yet and we are holding a card
   on file (card_saved_at). Interpreted only by payment-payme.ts#subscriptionIsPaying.';

-- When the seller put his card on file. Its presence, together with a NULL provider_ref, is the
-- whole of the armed state; the token itself is `buyer_key`, which no read that feeds a page selects.
ALTER TABLE seller_subscriptions ADD COLUMN IF NOT EXISTS card_saved_at timestamptz;

COMMENT ON COLUMN seller_subscriptions.card_saved_at IS
  'When the seller put a card on file, before any subscription existed at PayMe. With provider_ref
   NULL this row is ARMED: the publication sweep starts the subscription the moment clearing is
   approved, so the seller never has to come back and press pay (lib/subscription-arm.ts).';

-- The sweep asks "who is armed and waiting" on a timer, which is a scan over this column alone.
CREATE INDEX IF NOT EXISTS seller_subscriptions_armed_idx
  ON seller_subscriptions (card_saved_at)
  WHERE card_saved_at IS NOT NULL AND provider_ref IS NULL;
