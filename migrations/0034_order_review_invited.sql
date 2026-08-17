-- When the buyer was invited to review this order.
--
-- The record IS the idempotency: `review-invite-run.ts` selects `WHERE review_invited_at IS NULL`
-- and stamps it before it sends, so a job that runs twice — which migration 0007's lease makes
-- unlikely and not impossible — cannot mail the same person the same request again. A "have I sent
-- this" derived from anything else (the review existing, a notification, a timestamp comparison)
-- would answer wrongly for the buyer who was asked and chose not to write one, which is most of
-- them.
--
-- On `orders` and not in a table of its own: it is one nullable fact about one order, with no life
-- and no state of its own — the opposite of `return_requests`, whose header argues the other side
-- of the same choice.
--
-- Stamped BEFORE the send, deliberately. The two failure modes are "a buyer is never asked" and "a
-- buyer is asked twice"; a stamp after a successful send would retry every transient SMTP failure
-- forever, and the mail this replaces is a nudge, not a receipt.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_invited_at timestamptz;

-- The sweep's own predicate: the un-invited, oldest first. Partial, so the index holds only the
-- orders still to be asked and shrinks back to nothing as the platform catches up — rather than
-- growing with every order ever placed.
CREATE INDEX IF NOT EXISTS orders_review_invite_idx
  ON orders (updated_at)
  WHERE review_invited_at IS NULL;

COMMENT ON COLUMN orders.review_invited_at IS
  'When the "how was it?" mail was sent (review-invite-run.ts). NULL = not yet asked.';
