-- When the parcel actually LEFT — the third clock, and the one that was being guessed at.
--
-- `paid_at` and `delivered_at` (0023) already exist because the payout hold needed them. Nothing
-- recorded the moment in between, so anything that wanted to reason from DISPATCH had to reason
-- from payment instead and absorb whatever the seller spent packing. That was tolerable for the
-- payout hold, which only ever needs a conservative outer bound. It is not tolerable for the two
-- things that read it now (owner, 2026-08-17):
--
--   · "How was it?" goes out N days after dispatch for an order nobody marked delivered. Measured
--     from payment, a seller who legitimately spent five days in `processing` — which is their
--     right, and which `SHIP_DEADLINE_BUSINESS_DAYS` already polices separately — got their buyer
--     asked to rate a parcel that had been in transit for two days.
--   · The review page offers "לא קיבלתי את ההזמנה" once a parcel is genuinely late. Same
--     arithmetic, and getting it wrong invites a case that does not exist yet.
--
-- **Stamped on the FIRST transition to 'shipped' and never cleared**, exactly like `delivered_at`,
-- and for the reason 0023 spells out at length: these columns answer "when did this happen", not
-- "what is it now". A status corrected shipped → processing → shipped must not restart a clock the
-- buyer has already been waiting through, and `updated_at` — the obvious-looking alternative — is
-- the last touch of ANY field and moves when a seller fixes a tracking number.
--
-- Written by `orders.ts#updateOrderIn` alongside the other two, never by a caller: there are
-- several paths that change a status, and a clock that depends on each of them remembering is a
-- clock that is wrong for whichever path is added next.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;

-- NOT backfilled, deliberately, and the same argument 0023 made about `delivered_at`: the only
-- candidate is `updated_at`, which for an old order is very likely LATER than the real dispatch, so
-- a backfill would push existing orders' clocks out rather than in. Those rows simply have no
-- `shipped_at` and fall through to the payment-based last resort, which is exactly the case that
-- constant exists for.

COMMENT ON COLUMN orders.shipped_at IS
  'First transition to shipped; never cleared. The dispatch clock (review-timing.ts). NULL for a
   self-pickup order, which never passes through shipped, and for rows written before 0036.';

-- The review-invite sweep scans "un-invited orders whose dispatch clock has elapsed". Partial on
-- the invite column, so the index holds only the orders still to be asked and shrinks back toward
-- nothing as the platform catches up — rather than growing with every order ever placed.
CREATE INDEX IF NOT EXISTS orders_review_invite_dispatch_idx
  ON orders (shipped_at)
  WHERE review_invited_at IS NULL;
